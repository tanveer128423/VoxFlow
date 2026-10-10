import { createRealtimeSession, type RealtimeSessionConfig } from "./api/voiceApi"
import {
  DEFAULT_AMBIENCE_VOLUME,
  DEFAULT_MIC_PROCESSING,
  applyVolume,
  buildAudioConstraints,
  clampAmbienceVolume,
  clampInterruptMinWords,
  clampVolume,
  type MicProcessing,
} from "./audioConfig"
import { WordGate } from "./wordGate"
import { InterruptionGate } from "./interruptionGate"
import {
  AMBIENCE_ASSET_URL,
  createAmbienceMixer,
  type AmbienceMixer,
} from "./ambience"

// Client-only session options (never sent to the backend). These control local
// playback/capture behavior and the word-count interruption gate. Minimum
// response delay is intentionally NOT here: it applies to the turn-based
// fallback only (the live WebRTC stream is unbuffered and cannot be delayed
// without dropping audio).
export type RealtimeClientOptions = {
  volume?: number
  micProcessing?: MicProcessing
  interruptMinWords?: number
  ambienceEnabled?: boolean
  ambienceVolume?: number
}

// Pure predicate (exported for unit testing): a new response supersedes a
// previous one when the previous is still active under a different id. This can
// happen when the word gate disables the server's auto-interrupt but
// create_response remains on.
export function isSupersedingResponse(
  prevActive: boolean,
  prevId: string | null,
  newId: string,
): boolean {
  return prevActive && prevId !== null && prevId !== newId
}

export type SpeechStartDecision = "proceed" | "withhold" | "ignore"

// Pure decision for a user speech-start event (exported for unit testing):
// - "ignore": a response is active and already being interrupted -> do nothing
//   (no re-arming, no redundant cancels/telemetry on repeated speech bursts).
// - "withhold": a response is active and the word gate is closed -> defer
//   barge-in and arm the one-shot safety timeout.
// - "proceed": either no response is active (start a user turn) or the gate is
//   open (interrupt now).
export function decideSpeechStart(
  responseActive: boolean,
  responseInterrupted: boolean,
  canInterrupt: boolean,
): SpeechStartDecision {
  if (responseActive && responseInterrupted) return "ignore"
  if (responseActive && !canInterrupt) return "withhold"
  return "proceed"
}

export type RealtimeState =
  | "connecting"
  | "listening"
  | "responding"
  | "ended"

type RealtimeCallbacks = {
  onState: (state: RealtimeState) => void
  onUserTranscript: (transcript: string) => void
  onAssistantTranscript: (responseId: string, transcript: string) => void
  onTurnComplete: (responseId: string) => void
  onTurnInterrupted: (responseId: string) => void
  onUserSpeechStarted: (interruptingResponse: boolean, responseId?: string) => void
  onUserSpeechStopped: () => void
  onAssistantResponseStarted: (responseId: string) => void
  onAssistantAudioStarted: (responseId: string) => void
  onSessionReady: () => void
  onError: (error: Error) => void
  onAudioPlaybackError: (error: Error) => void
}

export class RealtimeConversation {
  private peerConnection: RTCPeerConnection | null = null
  private microphoneStream: MediaStream | null = null
  private dataChannel: RTCDataChannel | null = null
  private remoteAudio: HTMLAudioElement
  private callbacks: RealtimeCallbacks
  private closed = true
  private responseActive = false
  private responseInterrupted = false
  private currentResponseId: string | null = null
  private volume = 1
  private micProcessing: MicProcessing = { ...DEFAULT_MIC_PROCESSING }
  private interruptMinWords = 0
  private ambienceVolume = DEFAULT_AMBIENCE_VOLUME
  private ambienceMixer: AmbienceMixer | null = null
  private readonly wordGate = new WordGate()
  private readonly interruption = new InterruptionGate(() =>
    this.performInterruption(),
  )

  constructor(callbacks: RealtimeCallbacks) {
    this.callbacks = callbacks
    this.remoteAudio = new Audio()
    this.remoteAudio.autoplay = true
    this.remoteAudio.muted = false
    this.remoteAudio.volume = 1
  }

  async connect(
    config: RealtimeSessionConfig = {},
    options: RealtimeClientOptions = {},
  ): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      throw new Error("This browser does not support realtime voice conversations.")
    }

    this.closed = false
    this.responseActive = false
    this.responseInterrupted = false
    this.currentResponseId = null
    this.volume =
      options.volume !== undefined ? clampVolume(options.volume) : 1
    this.micProcessing = options.micProcessing ?? { ...DEFAULT_MIC_PROCESSING }
    this.interruptMinWords =
      options.interruptMinWords !== undefined
        ? clampInterruptMinWords(options.interruptMinWords)
        : 0
    this.ambienceVolume =
      options.ambienceVolume !== undefined
        ? clampAmbienceVolume(options.ambienceVolume)
        : DEFAULT_AMBIENCE_VOLUME
    this.wordGate.reset(null)
    this.interruption.clear()
    this.ambienceMixer?.dispose()
    this.ambienceMixer = null
    applyVolume(this.remoteAudio, this.volume)
    this.callbacks.onState("connecting")
    try {
      this.microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: buildAudioConstraints(this.micProcessing),
        video: false,
      })
      const session = await createRealtimeSession(config)
      const peerConnection = new RTCPeerConnection()
      this.peerConnection = peerConnection
      peerConnection.ontrack = (event) => {
        const stream = event.streams[0] ?? new MediaStream([event.track])
        this.remoteAudio.srcObject = stream
        console.info("[VoxFlow] Remote audio track received.", {
          kind: event.track.kind,
          readyState: event.track.readyState,
          muted: event.track.muted,
        })
        const responseId = this.responseActive
          ? this.currentResponseId ?? undefined
          : undefined
        void this.playRemoteAudio(responseId).catch(() => undefined)
      }
      // When ambience is enabled, mix it into the outgoing stream and send the
      // mixed track instead of the raw mic. If the mixer cannot be built (asset
      // fetch/decode failure, no Web Audio), fall back to the raw microphone so
      // the conversation still works.
      if (options.ambienceEnabled) {
        this.ambienceMixer = await createAmbienceMixer(
          this.microphoneStream,
          AMBIENCE_ASSET_URL,
          this.ambienceVolume,
        )
      }
      const outgoingStream: MediaStream | { getAudioTracks: () => MediaStreamTrack[] } =
        this.ambienceMixer?.outputStream ?? this.microphoneStream
      outgoingStream.getAudioTracks().forEach((track) => {
        peerConnection.addTrack(track, this.microphoneStream as MediaStream)
      })
      peerConnection.addEventListener(
        "connectionstatechange",
        this.handleConnectionStateChange,
      )
      peerConnection.addEventListener(
        "iceconnectionstatechange",
        this.handleIceConnectionStateChange,
      )

      const dataChannel = peerConnection.createDataChannel("oai-events")
      this.dataChannel = dataChannel
      dataChannel.addEventListener("open", () => {
        dataChannel.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              model: session.model,
              ...(session.instructions
                ? { instructions: session.instructions }
                : {}),
              audio: {
                input: {
                  turn_detection: {
                    type: "server_vad",
                    threshold: session.turn_detection.threshold,
                    prefix_padding_ms: session.turn_detection.prefix_padding_ms,
                    silence_duration_ms:
                      session.turn_detection.silence_duration_ms,
                    create_response: true,
                    // When a word-count gate is configured, disable the
                    // server's automatic interruption so the client can
                    // withhold barge-in until the threshold is met. With no
                    // gate (default 0) the server interrupts immediately, which
                    // preserves the current behavior.
                    interrupt_response: this.interruptMinWords === 0,
                  },
                  transcription: {
                    model: session.transcription_model,
                  },
                },
                output: {
                  voice: session.voice,
                },
              },
            },
          }),
        )
        this.callbacks.onState("listening")
        this.callbacks.onSessionReady()
      })
      dataChannel.addEventListener("message", this.handleMessage)
      dataChannel.addEventListener("error", this.handleDataChannelError)

      const offer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(offer)
      const sdpResponse = await fetch(
        `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(session.model)}`,
        {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${session.client_secret}`,
            "Content-Type": "application/sdp",
          },
        },
      )
      if (!sdpResponse.ok) {
        throw new Error("OpenAI could not establish the realtime connection.")
      }
      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: await sdpResponse.text(),
      })
    } catch (error) {
      this.close()
      throw error instanceof Error
        ? error
        : new Error("Could not start the realtime conversation.")
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.responseActive = false
    this.responseInterrupted = false
    this.interruption.clear()
    this.ambienceMixer?.dispose()
    this.ambienceMixer = null

    const dataChannel = this.dataChannel
    const peerConnection = this.peerConnection
    const microphoneStream = this.microphoneStream
    this.dataChannel = null
    this.peerConnection = null
    this.microphoneStream = null
    dataChannel?.removeEventListener("message", this.handleMessage)
    dataChannel?.removeEventListener("error", this.handleDataChannelError)
    peerConnection?.removeEventListener(
      "connectionstatechange",
      this.handleConnectionStateChange,
    )
    peerConnection?.removeEventListener(
    "iceconnectionstatechange",
    this.handleIceConnectionStateChange,
    )
    dataChannel?.close()
    peerConnection?.close()
    microphoneStream?.getTracks().forEach((track) => track.stop())
    this.remoteAudio.pause()
    this.remoteAudio.srcObject = null
    this.callbacks.onState("ended")
  }

  async enableAudio(): Promise<void> {
    const responseId = this.responseActive
      ? this.currentResponseId ?? undefined
      : undefined
    await this.playRemoteAudio(responseId)
  }

  // Set the Live playback volume (0.0-1.0) immediately on the audio element.
  setVolume(value: number): void {
    this.volume = clampVolume(value)
    applyVolume(this.remoteAudio, this.volume)
  }

  // Adjust the background ambience mix gain live (no-op when ambience is off).
  setAmbienceVolume(value: number): void {
    this.ambienceVolume = clampAmbienceVolume(value)
    this.ambienceMixer?.setVolume(this.ambienceVolume)
  }

  private canInterruptNow(): boolean {
    return (
      this.interruptMinWords === 0 ||
      this.wordGate.canInterrupt(this.interruptMinWords)
    )
  }

  private performInterruption(): void {
    if (this.closed || !this.responseActive) return
    const interruptedResponseId = this.currentResponseId ?? undefined
    this.responseInterrupted = true
    this.remoteAudio.pause()
    if (this.dataChannel?.readyState === "open") {
      this.dataChannel.send(JSON.stringify({ type: "response.cancel" }))
    }
    this.callbacks.onUserSpeechStarted(true, interruptedResponseId)
    this.callbacks.onState("listening")
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.close()
    this.callbacks.onError(error)
  }

  private readonly handleConnectionStateChange = (): void => {
    const state = this.peerConnection?.connectionState
    console.info("[VoxFlow] WebRTC connection state:", state)
    if (state === "failed" || state === "disconnected") {
      this.fail(new Error("The realtime connection was lost. Please try again."))
    }
  }

  private readonly handleIceConnectionStateChange = (): void => {
    console.info("[VoxFlow] WebRTC ICE state:", this.peerConnection?.iceConnectionState)
  }

  private readonly handleDataChannelError = (): void => {
    this.fail(new Error("Realtime event channel failed."))
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    this.handleEvent(event.data)
  }

  private async playRemoteAudio(responseId?: string): Promise<void> {
    console.info("[VoxFlow] Attempting assistant audio playback.", {
      hasStream: Boolean(this.remoteAudio.srcObject),
      muted: this.remoteAudio.muted,
      volume: this.remoteAudio.volume,
    })
    try {
      await this.remoteAudio.play()
      if (
        responseId &&
        this.responseActive &&
        this.currentResponseId === responseId &&
        !this.responseInterrupted
      ) {
        this.callbacks.onAssistantAudioStarted(responseId)
      }
    } catch (error) {
      const playbackError = error instanceof Error
        ? error
        : new Error("Assistant audio playback was blocked by the browser.")
      console.warn("[VoxFlow] Assistant audio playback failed.", {
        name: playbackError.name,
        message: playbackError.message,
      })
      this.callbacks.onAudioPlaybackError(
        new Error("Assistant audio is blocked. Select Enable audio to start playback."),
      )
      throw playbackError
    }
  }

  private handleEvent(rawEvent: string): void {
    let event: {
      type?: string
      delta?: string
      transcript?: string
      response?: { id?: string }
    }
    try {
      event = JSON.parse(rawEvent) as typeof event
    } catch {
      return
    }
    switch (event.type) {
      case "input_audio_buffer.speech_started": {
        const responseActive = this.responseActive
        const decision = decideSpeechStart(
          responseActive,
          this.responseInterrupted,
          this.canInterruptNow(),
        )
        // Already interrupting this response: ignore further speech bursts so a
        // new safety timer is never armed and no redundant forced interruption
        // or telemetry churn occurs until the response ends.
        if (decision === "ignore") break
        if (decision === "withhold") {
          // Gate closed: defer barge-in but arm the one-shot safety timeout so
          // a user who keeps speaking is never trapped.
          this.interruption.arm()
          break
        }
        // "proceed": no active response (start a turn) or the gate is open.
        this.interruption.clear()
        const interruptedResponseId = responseActive
          ? this.currentResponseId ?? undefined
          : undefined
        if (responseActive) {
          this.responseInterrupted = true
          this.remoteAudio.pause()
          if (this.dataChannel?.readyState === "open") {
            this.dataChannel.send(JSON.stringify({ type: "response.cancel" }))
          }
        }
        this.callbacks.onUserSpeechStarted(responseActive, interruptedResponseId)
        this.callbacks.onState("listening")
        break
      }
      case "input_audio_buffer.speech_stopped":
        // The user stopped speaking: cancel any pending forced interruption so a
        // brief sub-threshold utterance never triggers a delayed barge-in. The
        // safety timeout only guards against a user who keeps speaking.
        this.interruption.clear()
        this.callbacks.onUserSpeechStopped()
        break
      case "response.created": {
        if (!event.response?.id) break
        const newResponseId = event.response.id
        // C1 guard: if the server starts a new response while a previous one is
        // still active (possible when the gate disables auto-interrupt but
        // create_response stays on), finalize the previous as interrupted so
        // client transcript/telemetry/state remain consistent. This does not
        // change what we send to the server; preventing overlapping server
        // audio itself requires live verification.
        if (
          isSupersedingResponse(
            this.responseActive,
            this.currentResponseId,
            newResponseId,
          )
        ) {
          const supersededId = this.currentResponseId as string
          this.responseActive = false
          this.callbacks.onTurnInterrupted(supersededId)
        }
        this.currentResponseId = newResponseId
        this.responseActive = true
        this.responseInterrupted = false
        this.wordGate.reset(this.currentResponseId)
        this.interruption.clear()
        this.callbacks.onAssistantResponseStarted(this.currentResponseId)
        if (this.remoteAudio.srcObject) {
          void this.playRemoteAudio(this.currentResponseId).catch(() => undefined)
        }
        this.callbacks.onState("responding")
        break
      }
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) this.callbacks.onUserTranscript(event.transcript)
        break
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta && this.currentResponseId) {
          this.wordGate.addDelta(event.delta)
          this.callbacks.onAssistantTranscript(this.currentResponseId, event.delta)
        }
        break
      case "response.done":
        if (!event.response?.id || event.response.id !== this.currentResponseId) break
        this.responseActive = false
        this.interruption.clear()
        if (this.responseInterrupted) {
          this.callbacks.onTurnInterrupted(event.response.id)
        } else {
          this.callbacks.onTurnComplete(event.response.id)
        }
        this.callbacks.onState("listening")
        break
      default:
        break
    }
  }
}

import { createRealtimeSession } from "./api/voiceApi"

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

  constructor(callbacks: RealtimeCallbacks) {
    this.callbacks = callbacks
    this.remoteAudio = new Audio()
    this.remoteAudio.autoplay = true
    this.remoteAudio.muted = false
    this.remoteAudio.volume = 1
  }

  async connect(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      throw new Error("This browser does not support realtime voice conversations.")
    }

    this.closed = false
    this.responseActive = false
    this.responseInterrupted = false
    this.currentResponseId = null
    this.callbacks.onState("connecting")
    try {
      this.microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      })
      const session = await createRealtimeSession()
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
      this.microphoneStream.getAudioTracks().forEach((track) => {
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
              audio: {
                input: {
                  turn_detection: {
                    type: "server_vad",
                    threshold: 0.65,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 600,
                    create_response: true,
                    interrupt_response: true,
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
      case "input_audio_buffer.speech_started":
        const interruptingResponse = this.responseActive
        const interruptedResponseId = interruptingResponse
          ? this.currentResponseId ?? undefined
          : undefined
        if (this.responseActive) {
          this.responseInterrupted = true
          this.remoteAudio.pause()
          if (this.dataChannel?.readyState === "open") {
            this.dataChannel.send(JSON.stringify({ type: "response.cancel" }))
          }
        }
        this.callbacks.onUserSpeechStarted(interruptingResponse, interruptedResponseId)
        this.callbacks.onState("listening")
        break
      case "input_audio_buffer.speech_stopped":
        this.callbacks.onUserSpeechStopped()
        break
      case "response.created":
        if (!event.response?.id) break
        this.currentResponseId = event.response.id
        this.responseActive = true
        this.responseInterrupted = false
        this.callbacks.onAssistantResponseStarted(this.currentResponseId)
        if (this.remoteAudio.srcObject) {
          void this.playRemoteAudio(this.currentResponseId).catch(() => undefined)
        }
        this.callbacks.onState("responding")
        break
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) this.callbacks.onUserTranscript(event.transcript)
        break
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta && this.currentResponseId) {
          this.callbacks.onAssistantTranscript(this.currentResponseId, event.delta)
        }
        break
      case "response.done":
        if (!event.response?.id || event.response.id !== this.currentResponseId) break
        this.responseActive = false
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

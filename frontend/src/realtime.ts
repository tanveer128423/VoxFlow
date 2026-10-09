import { createRealtimeSession } from "./api/voiceApi"

export type RealtimeState =
  | "connecting"
  | "listening"
  | "responding"
  | "ended"

type RealtimeCallbacks = {
  onState: (state: RealtimeState) => void
  onUserTranscript: (transcript: string) => void
  onAssistantTranscript: (transcript: string) => void
  onTurnComplete: () => void
  onTurnInterrupted: () => void
  onError: (error: Error) => void
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

  constructor(callbacks: RealtimeCallbacks) {
    this.callbacks = callbacks
    this.remoteAudio = new Audio()
    this.remoteAudio.autoplay = true
  }

  async connect(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      throw new Error("This browser does not support realtime voice conversations.")
    }

    this.closed = false
    this.responseActive = false
    this.responseInterrupted = false
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
      this.microphoneStream.getAudioTracks().forEach((track) => {
        peerConnection.addTrack(track, this.microphoneStream as MediaStream)
      })
      peerConnection.ontrack = (event) => {
        this.remoteAudio.srcObject = event.streams[0]
        void this.remoteAudio.play().catch(() => undefined)
      }
      peerConnection.addEventListener(
        "connectionstatechange",
        this.handleConnectionStateChange,
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
              },
            },
          }),
        )
        this.callbacks.onState("listening")
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
    dataChannel?.close()
    peerConnection?.close()
    microphoneStream?.getTracks().forEach((track) => track.stop())
    this.remoteAudio.pause()
    this.remoteAudio.srcObject = null
    this.callbacks.onState("ended")
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.close()
    this.callbacks.onError(error)
  }

  private readonly handleConnectionStateChange = (): void => {
    const state = this.peerConnection?.connectionState
    if (state === "failed" || state === "disconnected") {
      this.fail(new Error("The realtime connection was lost. Please try again."))
    }
  }

  private readonly handleDataChannelError = (): void => {
    this.fail(new Error("Realtime event channel failed."))
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    this.handleEvent(event.data)
  }

  private handleEvent(rawEvent: string): void {
    let event: { type?: string; delta?: string; transcript?: string }
    try {
      event = JSON.parse(rawEvent) as typeof event
    } catch {
      return
    }
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        if (this.responseActive) {
          this.responseInterrupted = true
          this.remoteAudio.pause()
          if (this.dataChannel?.readyState === "open") {
            this.dataChannel.send(JSON.stringify({ type: "response.cancel" }))
          }
        }
        this.callbacks.onState("listening")
        break
      case "response.created":
        this.responseActive = true
        this.responseInterrupted = false
        this.callbacks.onState("responding")
        break
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) this.callbacks.onUserTranscript(event.transcript)
        break
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) this.callbacks.onAssistantTranscript(event.delta)
        break
      case "response.done":
        this.responseActive = false
        if (this.responseInterrupted) {
          this.callbacks.onTurnInterrupted()
        } else {
          this.callbacks.onTurnComplete()
        }
        this.callbacks.onState("listening")
        break
      default:
        break
    }
  }
}

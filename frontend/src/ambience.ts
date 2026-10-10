// Optional background ambience (e.g. office typing) mixed into the OUTGOING
// microphone stream for Live Realtime, so the assistant hears a realistic noisy
// environment. This is the opposite of microphone noise suppression and is
// unrelated to it.
//
// Design: Web Audio API graph
//   micSource ----------------\
//                              >--> MediaStreamAudioDestinationNode -> track
//   bufferSource -> gainNode -/
// The destination's stream track replaces the raw mic track when added to the
// RTCPeerConnection. If anything fails (asset fetch/decode, no Web Audio), the
// mixer returns null and the caller falls back to the raw microphone.
//
// The Web Audio types are referenced structurally through small interfaces so
// the mixer can be unit-tested with mocks in a DOM-free environment. These unit
// tests verify graph construction, gain, fallback, and cleanup — NOT the actual
// audible mix, which requires live verification.

export const AMBIENCE_ASSET_URL = `${import.meta.env.BASE_URL}ambience/keyboard-typing.mp3`

// Attribution / provenance (also recorded in the README):
//   "Keyboard Typing" by imsogabriel_Stock — https://pixabay.com/sound-effects/technology-keyboard-typing-120457/
//   Pixabay Content License (royalty-free, no attribution required).

type AudioNodeLike = {
  connect: (destination: unknown) => void
  disconnect: () => void
}

type GainNodeLike = AudioNodeLike & { gain: { value: number } }

type BufferSourceLike = AudioNodeLike & {
  buffer: unknown
  loop: boolean
  start: () => void
  stop: () => void
}

type DestinationLike = AudioNodeLike & {
  stream: { getAudioTracks: () => MediaStreamTrack[] }
}

export type AudioContextLike = {
  createMediaStreamSource: (stream: MediaStream) => AudioNodeLike
  createMediaStreamDestination: () => DestinationLike
  createBufferSource: () => BufferSourceLike
  createGain: () => GainNodeLike
  decodeAudioData: (data: ArrayBuffer) => Promise<unknown>
  close: () => Promise<void> | void
}

export type AmbienceDeps = {
  createContext: () => AudioContextLike | null
  fetchAsset: (url: string) => Promise<ArrayBuffer>
}

export type AmbienceMixer = {
  // Stream whose single audio track carries mic + ambience, to be sent instead
  // of the raw microphone track.
  outputStream: { getAudioTracks: () => MediaStreamTrack[] }
  setVolume: (value: number) => void
  dispose: () => void
}

function defaultCreateContext(): AudioContextLike | null {
  const Ctor =
    typeof window !== "undefined"
      ? ((window as unknown as {
          AudioContext?: new () => AudioContextLike
          webkitAudioContext?: new () => AudioContextLike
        }).AudioContext ??
        (window as unknown as {
          webkitAudioContext?: new () => AudioContextLike
        }).webkitAudioContext)
      : undefined
  return Ctor ? new Ctor() : null
}

async function defaultFetchAsset(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Ambience asset request failed: ${response.status}`)
  }
  return response.arrayBuffer()
}

// Build the mixer. Returns null (never throws) when ambience cannot be set up,
// so the caller keeps using the raw microphone unchanged.
export async function createAmbienceMixer(
  micStream: MediaStream,
  url: string,
  volume: number,
  deps: Partial<AmbienceDeps> = {},
): Promise<AmbienceMixer | null> {
  const createContext = deps.createContext ?? defaultCreateContext
  const fetchAsset = deps.fetchAsset ?? defaultFetchAsset

  let context: AudioContextLike | null = null
  try {
    context = createContext()
    if (!context) return null

    const data = await fetchAsset(url)
    const decoded = await context.decodeAudioData(data)

    const destination = context.createMediaStreamDestination()
    const micSource = context.createMediaStreamSource(micStream)
    micSource.connect(destination)

    const gain = context.createGain()
    gain.gain.value = clampGain(volume)
    gain.connect(destination)

    const source = context.createBufferSource()
    source.buffer = decoded
    source.loop = true
    source.connect(gain)
    source.start()

    let disposed = false
    const activeContext = context
    return {
      outputStream: destination.stream,
      setVolume: (value: number) => {
        if (disposed) return
        gain.gain.value = clampGain(value)
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        try {
          source.stop()
        } catch {
          // Already stopped; ignore.
        }
        source.disconnect()
        gain.disconnect()
        micSource.disconnect()
        void Promise.resolve(activeContext.close()).catch(() => undefined)
      },
    }
  } catch {
    // Best-effort cleanup of a partially built context, then fall back.
    if (context) {
      try {
        void Promise.resolve(context.close()).catch(() => undefined)
      } catch {
        // ignore
      }
    }
    return null
  }
}

function clampGain(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

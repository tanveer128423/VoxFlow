import { describe, expect, it, vi } from "vitest"

import { createAmbienceMixer, type AudioContextLike } from "./ambience"

// A mock Web Audio graph. These tests verify graph construction, gain, the
// fallback path, and cleanup — NOT the actual audible mix (which requires live
// verification in a real browser).
function makeMockContext() {
  const micSource = { connect: vi.fn(), disconnect: vi.fn() }
  const gain = { gain: { value: -1 }, connect: vi.fn(), disconnect: vi.fn() }
  const source = {
    buffer: null as unknown,
    loop: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
  const track = { kind: "audio" } as unknown as MediaStreamTrack
  const destination = {
    stream: { getAudioTracks: () => [track] },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
  const close = vi.fn()
  const context: AudioContextLike = {
    createMediaStreamSource: vi.fn(() => micSource),
    createMediaStreamDestination: vi.fn(() => destination),
    createBufferSource: vi.fn(() => source),
    createGain: vi.fn(() => gain),
    decodeAudioData: vi.fn(async () => ({ decoded: true })),
    close,
  }
  return { context, micSource, gain, source, destination, track, close }
}

const fakeMic = {} as unknown as MediaStream

describe("createAmbienceMixer", () => {
  it("builds the mic + ambience graph and returns the mixed stream", async () => {
    const mock = makeMockContext()
    const fetchAsset = vi.fn(async () => new ArrayBuffer(8))

    const mixer = await createAmbienceMixer(fakeMic, "/a.mp3", 0.4, {
      createContext: () => mock.context,
      fetchAsset,
    })

    expect(mixer).not.toBeNull()
    expect(fetchAsset).toHaveBeenCalledWith("/a.mp3")
    // Ambience source loops and is started.
    expect(mock.source.loop).toBe(true)
    expect(mock.source.start).toHaveBeenCalledTimes(1)
    // Gain reflects the requested volume.
    expect(mock.gain.gain.value).toBe(0.4)
    // Graph: mic -> destination, source -> gain -> destination.
    expect(mock.micSource.connect).toHaveBeenCalledWith(mock.destination)
    expect(mock.source.connect).toHaveBeenCalledWith(mock.gain)
    expect(mock.gain.connect).toHaveBeenCalledWith(mock.destination)
    // Output is the destination stream's track.
    expect(mixer!.outputStream.getAudioTracks()).toEqual([mock.track])
  })

  it("setVolume updates the gain and is clamped", async () => {
    const mock = makeMockContext()
    const mixer = await createAmbienceMixer(fakeMic, "/a.mp3", 0.3, {
      createContext: () => mock.context,
      fetchAsset: async () => new ArrayBuffer(8),
    })
    mixer!.setVolume(0.8)
    expect(mock.gain.gain.value).toBe(0.8)
    mixer!.setVolume(5)
    expect(mock.gain.gain.value).toBe(1)
    mixer!.setVolume(-2)
    expect(mock.gain.gain.value).toBe(0)
  })

  it("dispose stops the source, disconnects nodes, and closes the context", async () => {
    const mock = makeMockContext()
    const mixer = await createAmbienceMixer(fakeMic, "/a.mp3", 0.3, {
      createContext: () => mock.context,
      fetchAsset: async () => new ArrayBuffer(8),
    })
    mixer!.dispose()
    expect(mock.source.stop).toHaveBeenCalledTimes(1)
    expect(mock.source.disconnect).toHaveBeenCalledTimes(1)
    expect(mock.gain.disconnect).toHaveBeenCalledTimes(1)
    expect(mock.micSource.disconnect).toHaveBeenCalledTimes(1)
    expect(mock.close).toHaveBeenCalledTimes(1)
    // Idempotent: a second dispose does nothing further.
    mixer!.dispose()
    expect(mock.source.stop).toHaveBeenCalledTimes(1)
    // setVolume after dispose is a no-op.
    mixer!.setVolume(0.9)
    expect(mock.gain.gain.value).not.toBe(0.9)
  })

  it("returns null (fallback) when Web Audio is unavailable", async () => {
    const mixer = await createAmbienceMixer(fakeMic, "/a.mp3", 0.3, {
      createContext: () => null,
      fetchAsset: async () => new ArrayBuffer(8),
    })
    expect(mixer).toBeNull()
  })

  it("returns null and closes the context when the asset fetch fails", async () => {
    const mock = makeMockContext()
    const mixer = await createAmbienceMixer(fakeMic, "/a.mp3", 0.3, {
      createContext: () => mock.context,
      fetchAsset: async () => {
        throw new Error("404")
      },
    })
    expect(mixer).toBeNull()
    expect(mock.close).toHaveBeenCalledTimes(1)
  })

  it("returns null when decoding fails", async () => {
    const mock = makeMockContext()
    mock.context.decodeAudioData = vi.fn(async () => {
      throw new Error("bad audio")
    })
    const mixer = await createAmbienceMixer(fakeMic, "/a.mp3", 0.3, {
      createContext: () => mock.context,
      fetchAsset: async () => new ArrayBuffer(8),
    })
    expect(mixer).toBeNull()
    expect(mock.close).toHaveBeenCalledTimes(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBusyAction } from './useBusyAction'

// This scheduler test exercises deferred work and cleanup without a DOM.
const harness = vi.hoisted(() => ({ cleanup: undefined as (() => void) | undefined }))
vi.mock('react', () => ({
  useCallback: <T,>(callback: T) => callback,
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(initial: T) => [initial, vi.fn()],
  useEffect: (effect: () => (() => void)) => { harness.cleanup = effect() },
}))

let frames: FrameRequestCallback[]
beforeEach(() => {
  frames = []
  harness.cleanup = undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
})
afterEach(() => vi.unstubAllGlobals())

function nextFrame() {
  const frame = frames.shift()
  if (!frame) throw new Error('No animation frame scheduled')
  frame(0)
}

describe('deferred busy actions', () => {
  it('still executes once after two frames while mounted', () => {
    const [, run] = useBusyAction()
    const work = vi.fn()
    run(work)
    run(work)
    nextFrame()
    expect(work).not.toHaveBeenCalled()
    nextFrame()
    expect(work).toHaveBeenCalledOnce()
  })

  it.each([0, 1])('cancels old-account work after unmount at frame %i', (frameCount) => {
    const [, run] = useBusyAction()
    const writeOldUserData = vi.fn()
    run(writeOldUserData)
    for (let frame = 0; frame < frameCount; frame++) nextFrame()
    harness.cleanup?.()
    while (frames.length) nextFrame()
    expect(writeOldUserData).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { closeStorage, initializeStorage } from './services/storage'
import { getAuthenticatedUser } from './services/authentication'

vi.mock('react-dom/client', () => ({ createRoot: vi.fn() }))
vi.mock('./App', () => ({ default: () => null }))
vi.mock('./services/storage', () => ({ initializeStorage: vi.fn(), closeStorage: vi.fn(), loadAppearance: vi.fn() }))
vi.mock('./services/authentication', () => ({ getAuthenticatedUser: vi.fn() }))
vi.mock('./utils/appearance', () => ({ applyAppearance: vi.fn() }))

const USER_A = '550e8400-e29b-41d4-a716-446655440000'
const USER_B = '650e8400-e29b-41d4-a716-446655440000'
const container = { textContent: '' }
const render = vi.fn()
const unmount = vi.fn()

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  container.textContent = ''
  vi.stubGlobal('document', { documentElement: {}, getElementById: () => container })
  vi.mocked(createRoot).mockReturnValue({ render, unmount })
  vi.mocked(closeStorage).mockResolvedValue()
  vi.mocked(initializeStorage).mockResolvedValue()
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: USER_A })
})

afterEach(() => vi.unstubAllGlobals())

describe('authenticated application startup', () => {
  it('resolves identity, then storage, before rendering React', async () => {
    let identify!: (user: { id: string }) => void
    let ready!: () => void
    vi.mocked(getAuthenticatedUser).mockReturnValue(new Promise((resolve) => { identify = resolve }))
    vi.mocked(initializeStorage).mockReturnValue(new Promise<void>((resolve) => { ready = resolve }))
    await import('./main')
    expect(initializeStorage).not.toHaveBeenCalled()
    expect(createRoot).not.toHaveBeenCalled()
    expect(container.textContent).toBe('Loading saved quizzes…')
    identify({ id: USER_A })
    await vi.waitFor(() => expect(initializeStorage).toHaveBeenCalledWith({ userId: USER_A, remoteUrl: undefined }))
    expect(createRoot).not.toHaveBeenCalled()
    ready()
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
    expect(createRoot).toHaveBeenCalledWith(container)
  })

  it.each(['identity', 'storage'])('shows sanitized %s errors without rendering an empty app', async (stage) => {
    vi.mocked(stage === 'identity' ? getAuthenticatedUser : initializeStorage)
      .mockRejectedValue(new Error('test-only-sensitive-details'))
    await import('./main')
    await vi.waitFor(() => expect(container.textContent).toContain('could not be opened'))
    expect(container.textContent).not.toContain('test-only-sensitive-details')
    expect(createRoot).not.toHaveBeenCalled()
    if (stage === 'identity') expect(initializeStorage).not.toHaveBeenCalled()
  })

  it('unmounts the old tree and drains storage before changing a server session', async () => {
    const { studyApplication } = await import('./main')
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
    let closed!: () => void
    vi.mocked(closeStorage).mockReturnValueOnce(new Promise((resolve) => { closed = resolve }))
    const authenticate = vi.fn().mockResolvedValue({ id: USER_B })
    const switching = studyApplication.changeAccount(authenticate)
    expect(unmount).toHaveBeenCalledOnce()
    expect(authenticate).not.toHaveBeenCalled()
    expect(render).toHaveBeenCalledOnce()
    closed()
    await switching
    expect(initializeStorage).toHaveBeenLastCalledWith({ userId: USER_B, remoteUrl: undefined })
    expect(createRoot).toHaveBeenCalledTimes(2)
    expect(render).toHaveBeenCalledTimes(2)
  })

  it('leaves React unmounted on logout or failed flush and allows retry', async () => {
    const { studyApplication } = await import('./main')
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
    const logout = vi.fn().mockResolvedValue(null)
    vi.mocked(closeStorage).mockRejectedValueOnce(new Error('secret-write-failure'))
    await expect(studyApplication.changeAccount(logout)).rejects.toThrow('could not be opened')
    expect(logout).not.toHaveBeenCalled()
    expect(render).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('secret-write-failure')
    await studyApplication.changeAccount(logout)
    expect(container.textContent).toContain('Signed out')
    expect(render).toHaveBeenCalledOnce()
  })

  it('suppresses a stale identity result when another account transition arrives', async () => {
    const { studyApplication } = await import('./main')
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
    let identify!: (user: { id: string }) => void
    const authenticate = vi.fn(() => new Promise<{ id: string }>((resolve) => { identify = resolve }))
    const first = studyApplication.changeAccount(authenticate)
    await vi.waitFor(() => expect(authenticate).toHaveBeenCalledOnce())
    const second = studyApplication.changeAccount(async () => ({ id: USER_B }))
    identify({ id: USER_A })
    await Promise.all([first, second])
    expect(initializeStorage).toHaveBeenCalledTimes(2)
    expect(initializeStorage).toHaveBeenLastCalledWith({ userId: USER_B, remoteUrl: undefined })
    expect(render).toHaveBeenCalledTimes(2)
  })
})

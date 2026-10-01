import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { closeStorage, initializeStorage } from './services/storage'
import { changePassword, getAuthenticatedUser, getStudyAccess, signIn, signOut } from './services/authentication'

vi.mock('react-dom/client', () => ({ createRoot: vi.fn() }))
vi.mock('./App', () => ({ default: () => null }))
vi.mock('./services/storage', () => ({ initializeStorage: vi.fn(), closeStorage: vi.fn(), loadAppearance: vi.fn() }))
vi.mock('./services/authentication', () => ({ changePassword: vi.fn(), getStudyAccess: vi.fn(), getAuthenticatedUser: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }))
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
  vi.mocked(getStudyAccess).mockResolvedValue({ id: USER_A })
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: USER_A })
  vi.mocked(signIn).mockResolvedValue('authenticated')
})

afterEach(() => vi.unstubAllGlobals())

describe('authenticated application startup', () => {
  it('resolves identity, then storage, before rendering React', async () => {
    let identify!: (user: { id: string }) => void
    let ready!: () => void
    vi.mocked(getStudyAccess).mockReturnValue(new Promise((resolve) => { identify = resolve }))
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
    vi.mocked(stage === 'identity' ? getStudyAccess : initializeStorage)
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
    expect(render).toHaveBeenCalledTimes(2)
    expect((render.mock.lastCall![0] as ReactElement<{ children: ReactElement }>).props.children.type).toHaveProperty('name', 'StudyLogin')
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


it('opens login on 401 and drains storage before login and logout cookie mutations', async () => {
  vi.mocked(getStudyAccess).mockResolvedValueOnce(null)
  const { studyApplication } = await import('./main')
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
  expect(initializeStorage).not.toHaveBeenCalled()
  const screen = (render.mock.lastCall![0] as ReactElement<{ children: ReactElement<{ onSignIn: (login: string, password: string) => Promise<void> }> }>).props.children
  expect(screen.type).toHaveProperty('name', 'StudyLogin')
  let closed!: () => void
  vi.mocked(closeStorage).mockReturnValueOnce(new Promise((resolve) => { closed = resolve }))
  const signingIn = screen.props.onSignIn('david', 'test password')
  expect(signIn).not.toHaveBeenCalled()
  closed()
  await signingIn
  expect(signIn).toHaveBeenCalledWith('david', 'test password')
  expect(initializeStorage).toHaveBeenCalledWith({ userId: USER_A, remoteUrl: undefined })
  const account = (render.mock.lastCall![0] as ReactElement<{ children: ReactElement<{ onSignOut: () => Promise<void> }> }>).props.children
  expect(account.type).toHaveProperty('name', 'StudyAccount')
  vi.mocked(signOut).mockResolvedValue(null)
  vi.mocked(closeStorage).mockReturnValueOnce(new Promise((resolve) => { closed = resolve }))
  const signingOut = account.props.onSignOut()
  expect(signOut).not.toHaveBeenCalled()
  closed()
  await signingOut
  expect(signOut).toHaveBeenCalledOnce()
  await studyApplication.reload()
})

function lastScreen<P>() {
  return (render.mock.lastCall![0] as ReactElement<{ children: ReactElement<P> }>).props.children
}

describe('first-login application lifecycle', () => {
  it('restores the restricted screen at startup without opening local storage', async () => {
    vi.mocked(getStudyAccess).mockResolvedValue({ mustChangePassword: true })
    await import('./main')
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
    expect(lastScreen().type).toHaveProperty('name', 'StudyChangePassword')
    expect(initializeStorage).not.toHaveBeenCalled()
    expect(getAuthenticatedUser).not.toHaveBeenCalled()
  })

  it('transitions login → password change → existing App, draining storage before both cookie mutations', async () => {
    vi.mocked(getStudyAccess).mockResolvedValueOnce(null)
    vi.mocked(signIn).mockResolvedValue('password_change_required')
    await import('./main')
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
    let closed!: () => void
    vi.mocked(closeStorage).mockReturnValueOnce(new Promise((resolve) => { closed = resolve }))
    const signingIn = lastScreen<{ onSignIn: (login: string, password: string) => Promise<void> }>()
      .props.onSignIn('pilot', 'temporary password')
    expect(signIn).not.toHaveBeenCalled()
    closed()
    await signingIn
    expect(lastScreen().type).toHaveProperty('name', 'StudyChangePassword')
    expect(initializeStorage).not.toHaveBeenCalled()
    expect(getAuthenticatedUser).not.toHaveBeenCalled()
    vi.mocked(closeStorage).mockReturnValueOnce(new Promise((resolve) => { closed = resolve }))
    const changing = lastScreen<{ onChangePassword: (password: string) => Promise<void> }>()
      .props.onChangePassword('permanent password')
    expect(changePassword).not.toHaveBeenCalled()
    expect(initializeStorage).not.toHaveBeenCalled()
    closed()
    await changing
    expect(changePassword).toHaveBeenCalledWith('permanent password')
    expect(initializeStorage).toHaveBeenCalledExactlyOnceWith({ userId: USER_A, remoteUrl: undefined })
    expect(lastScreen<{ children: ReactElement }>().type).toHaveProperty('name', 'StudyAccount')
    const { default: App } = await import('./App')
    expect(lastScreen<{ children: ReactElement }>().props.children.type).toBe(App)
  })

  it('cancels the restricted session after storage closes and returns to login', async () => {
    vi.mocked(getStudyAccess).mockResolvedValue({ mustChangePassword: true })
    vi.mocked(signOut).mockResolvedValue(null)
    await import('./main')
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
    let closed!: () => void
    vi.mocked(closeStorage).mockReturnValueOnce(new Promise((resolve) => { closed = resolve }))
    const cancelling = lastScreen<{ onSignOut: () => Promise<void> }>().props.onSignOut()
    expect(signOut).not.toHaveBeenCalled()
    closed()
    await cancelling
    expect(signOut).toHaveBeenCalledOnce()
    expect(lastScreen().type).toHaveProperty('name', 'StudyLogin')
    expect(initializeStorage).not.toHaveBeenCalled()
  })

  it.each([true, false])('recovers password-change failures using current auth state (restricted=%s)', async (restricted) => {
    vi.mocked(getStudyAccess).mockResolvedValueOnce({ mustChangePassword: true })
    vi.mocked(changePassword).mockRejectedValue(new Error('Password change could not be completed.'))
    await import('./main')
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
    vi.mocked(getStudyAccess).mockResolvedValue(restricted ? { mustChangePassword: true } : null)
    await lastScreen<{ onChangePassword: (password: string) => Promise<void> }>().props.onChangePassword('new password')
    expect(lastScreen().type).toHaveProperty('name', restricted ? 'StudyChangePassword' : 'StudyLogin')
    expect(lastScreen<{ error: string }>().props.error).toContain('Password change could not be completed')
    expect(initializeStorage).not.toHaveBeenCalled()
  })
})

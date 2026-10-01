import { getStudyAccess, type StudyAccess } from './authentication'
import { closeStorage, initializeStorage } from './storage'
import { canonicalUserId, type AuthenticatedUser } from './userIdentity'

interface StudyView {
  unmount(): void
  render(user: AuthenticatedUser): void
  status(message: string): void
  signedOut?(): void
  passwordChangeRequired(): void
}

const STARTUP_ERROR = 'Study mode could not be opened. Verify your sign-in and browser storage, then retry. Your stored data has not been cleared.'

/** Authentication belongs here, outside the quiz tree and its synchronous API. */
export function createStudyBootstrap(view: StudyView, remoteUrl?: string) {
  let revision = 0
  let queue: Promise<void> = Promise.resolve()

  /**
   * Login/logout/password changes must change the server session INSIDE this callback.
   * React is unmounted and old writes/sync/handles are closed before it runs.
   * Returning null leaves the application signed out without deleting data.
   */
  function changeAccount(authenticate: () => Promise<StudyAccess>): Promise<void> {
    const current = ++revision
    view.unmount()
    view.status('Loading saved quizzes…')
    const closing = closeStorage()
    const transition = queue.then(async () => {
      await closing
      if (current !== revision) return
      const resolved = await authenticate()
      if (current !== revision) return
      if (resolved === null) {
        view.status('Signed out. Sign in to open your saved quizzes.')
        view.signedOut?.()
        return
      }
      if ('mustChangePassword' in resolved) {
        view.passwordChangeRequired()
        return
      }
      const user = { ...resolved, id: canonicalUserId(resolved.id) }
      await initializeStorage({ userId: user.id, remoteUrl })
      if (current !== revision) return
      view.render(user)
    }).catch(() => {
      if (current === revision) view.status(STARTUP_ERROR)
      throw new Error(STARTUP_ERROR)
    })
    queue = transition.catch(() => undefined)
    return transition
  }

  return {
    changeAccount,
    reload: () => changeAccount(getStudyAccess),
  }
}

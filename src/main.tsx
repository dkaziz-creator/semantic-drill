import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import './index.css'
import App from './App'
import { loadAppearance } from './services/storage'
import { createStudyBootstrap } from './services/studyBootstrap'
import { applyAppearance } from './utils/appearance'
import { getAuthenticatedUser, signIn, signOut } from './services/authentication'
import { StudyAccount, StudyLogin } from './components/StudyLogin'

// Device appearance can be applied before authentication; learning data cannot.
applyAppearance(document.documentElement, loadAppearance())

const container = document.getElementById('root')!
let root: Root | undefined
let signInError: string | undefined

// All cookie changes happen after the previous user's storage and sync close.
export const studyApplication = createStudyBootstrap({
  unmount() {
    root?.unmount()
    root = undefined
  },
  status(message) { container.textContent = message },
  signedOut() {
    container.textContent = ''
    root = createRoot(container)
    root.render(<StrictMode><StudyLogin error={signInError} onSignIn={async (login, password) => {
      await studyApplication.changeAccount(async () => {
        signInError = undefined
        try {
          await signIn(login, password)
          // Re-read /me before opening any local database.
          return await getAuthenticatedUser()
        } catch (error) {
          signInError = error instanceof Error ? error.message : 'Sign-in is unavailable. Please retry.'
          return null
        }
      })
    }} /></StrictMode>)
  },
  render(user) {
    container.textContent = ''
    root = createRoot(container)
    root.render(<StrictMode><StudyAccount user={user} onSignOut={async () => {
      signInError = undefined
      await studyApplication.changeAccount(signOut)
    }}><App key={user.id} /></StudyAccount></StrictMode>)
  },
}, import.meta.env.VITE_LEARNING_SYNC_URL)

// The bootstrap displays sanitized errors and never renders an unreadable cache.
void studyApplication.reload().catch(() => undefined)

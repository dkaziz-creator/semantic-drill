import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import './index.css'
import App from './App'
import { loadAppearance } from './services/storage'
import { createStudyBootstrap } from './services/studyBootstrap'
import { applyAppearance } from './utils/appearance'
import { changePassword, getAuthenticatedUser, getStudyAccess, signIn, signOut } from './services/authentication'
import { StudyAccount, StudyLogin } from './components/StudyLogin'
import { StudyChangePassword } from './components/StudyChangePassword'

// Device appearance can be applied before authentication; learning data cannot.
applyAppearance(document.documentElement, loadAppearance())

const container = document.getElementById('root')!
let root: Root | undefined
let authError: string | undefined

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
    root.render(<StrictMode><StudyLogin error={authError} onSignIn={async (login, password) => {
      await studyApplication.changeAccount(async () => {
        authError = undefined
        try {
          const status = await signIn(login, password)
          if (status === 'password_change_required') return { mustChangePassword: true }
          // Re-read /me before opening any local database.
          return await getAuthenticatedUser()
        } catch (error) {
          authError = error instanceof Error ? error.message : 'Sign-in is unavailable. Please retry.'
          return null
        }
      })
    }} /></StrictMode>)
  },
  passwordChangeRequired() {
    container.textContent = ''
    root = createRoot(container)
    root.render(<StrictMode><StudyChangePassword error={authError} onChangePassword={async (password) => {
      await studyApplication.changeAccount(async () => {
        authError = undefined
        try { await changePassword(password) }
        catch (error) {
          authError = error instanceof Error ? error.message : 'Password change is unavailable. Please retry.'
        }
        // Recover the actual state even if the password write succeeded but the
        // response or session creation failed. Never open storage without /me.
        return getStudyAccess()
      })
    }} onSignOut={async () => {
      authError = undefined
      await studyApplication.changeAccount(signOut)
    }} /></StrictMode>)
  },
  render(user) {
    container.textContent = ''
    root = createRoot(container)
    root.render(<StrictMode><StudyAccount user={user} onSignOut={async () => {
      authError = undefined
      await studyApplication.changeAccount(signOut)
    }}><App key={user.id} /></StudyAccount></StrictMode>)
  },
}, import.meta.env.VITE_LEARNING_SYNC_URL)

// The bootstrap displays sanitized errors and never renders an unreadable cache.
void studyApplication.reload().catch(() => undefined)

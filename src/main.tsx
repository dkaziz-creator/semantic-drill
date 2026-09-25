import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import './index.css'
import App from './App'
import { loadAppearance } from './services/storage'
import { createStudyBootstrap } from './services/studyBootstrap'
import { applyAppearance } from './utils/appearance'

// Device appearance can be applied before authentication; learning data cannot.
applyAppearance(document.documentElement, loadAppearance())

const container = document.getElementById('root')!
let root: Root | undefined

// Future login code uses changeAccount; it must not change session cookies
// first and leave the previous user's live replication attached to the gateway.
export const studyApplication = createStudyBootstrap({
  unmount() {
    root?.unmount()
    root = undefined
  },
  status(message) { container.textContent = message },
  render(user) {
    container.textContent = ''
    root = createRoot(container)
    root.render(<StrictMode><App key={user.id} /></StrictMode>)
  },
}, import.meta.env.VITE_LEARNING_SYNC_URL)

// The bootstrap displays sanitized errors and never renders an unreadable cache.
void studyApplication.reload().catch(() => undefined)

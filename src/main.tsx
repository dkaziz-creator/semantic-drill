import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { initializeStorage, loadAppearance } from './services/storage'
import { applyAppearance } from './utils/appearance'

// Applied before the first render so the app never paints at the default font
// size and then jumps. Deliberately not an inline script in index.html: that
// would put a storage key outside services/storage.ts. `useAppearance` re-applies
// the same values in its effect, which is a no-op.
applyAppearance(document.documentElement, loadAppearance())

const container = document.getElementById('root')!
container.textContent = 'Loading saved quizzes…'

void initializeStorage({ remoteUrl: import.meta.env.VITE_COUCHDB_URL }).then(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}).catch(() => {
  // Never render an empty, uninitialized cache over an unreadable database.
  // Keep the message independent of raw errors/URLs, which can contain secrets.
  container.textContent = 'Saved quizzes could not be opened. Allow browser storage and reload to try again. Your stored data has not been cleared.'
})

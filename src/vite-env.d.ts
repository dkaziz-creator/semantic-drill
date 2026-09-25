/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Same-origin authenticated sync gateway; never a database name or secret. */
  readonly VITE_LEARNING_SYNC_URL?: string
  /** Trusted developer fixture, honored only by Vite's development mode. */
  readonly VITE_DEV_USER_ID?: string
}

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public CouchDB database endpoint; never put credentials in a Vite variable. */
  readonly VITE_COUCHDB_URL?: string
}

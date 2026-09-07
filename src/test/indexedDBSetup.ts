import 'fake-indexeddb/auto'

// PouchDB's browser distribution expects the browser/worker global even when
// its IndexedDB adapter is exercised in Vitest's Node environment.
Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true })

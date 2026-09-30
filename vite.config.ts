import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// base: './' produces relative asset URLs, so the same build works on
// GitHub Pages (served from /DrillMCQ/) and Vercel (served from /).
export default defineConfig({
  base: './',
  // PouchDB imports the Node-compatible emitter; bundle its browser package.
  resolve: { alias: { events: 'events/' } },
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api/auth': 'http://127.0.0.1:3000', '/couchdb': 'http://127.0.0.1:3000' } },
  test: { include: ['src/**/*.test.{ts,tsx}'], setupFiles: ['./src/test/indexedDBSetup.ts'] },
})

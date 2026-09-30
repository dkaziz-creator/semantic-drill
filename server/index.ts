import { resolve } from 'node:path'
import { loadConfig, AUTH_DATABASE } from './config.js'
import { CouchClient } from './couch/client.js'
import { createStudyServer } from './app.js'

try {
  const config = loadConfig()
  const couch = new CouchClient(config)
  // Provisioning is explicit. Startup never creates databases or changes security.
  await couch.request('GET', `/${AUTH_DATABASE}`)
  const server = createStudyServer(config, {
    staticDirectory: resolve('dist'), log: (entry) => console.log(JSON.stringify(entry)),
  })
  server.on('error', () => { console.error(JSON.stringify({ event: 'listen_failed' })); process.exitCode = 1 })
  server.listen(config.port, config.host, () => console.log(JSON.stringify({ event: 'listening', port: config.port })))
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    server.close()
    server.closeAllConnections()
  })
} catch (error) {
  // Configuration messages contain variable names only. Never print a transport error/URL.
  console.error(JSON.stringify({ event: 'startup_failed', message:
    error instanceof Error && /^(Missing required configuration:|Invalid configuration:|Production requires)/.test(error.message)
      ? error.message : 'Check internal CouchDB connectivity, credentials, and provision the authentication database with create-study-user.' }))
  process.exitCode = 1
}

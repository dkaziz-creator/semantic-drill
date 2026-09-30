import { parseArgs } from 'node:util'
import { loadConfig } from '../config.js'
import { CouchClient } from '../couch/client.js'
import { CouchError } from '../couch/client.js'
import { provisionUser } from '../couch/provisioning.js'

try {
  const { values } = parseArgs({ options: {
    login: { type: 'string' }, 'display-name': { type: 'string' },
    'password-stdin': { type: 'boolean' }, resume: { type: 'boolean' },
  } })
  if (!values.login || (!values.resume && !values['password-stdin'])) {
    throw new Error('Usage: create-study-user --login LOGIN --display-name NAME --password-stdin (or --login LOGIN --resume)')
  }
  let password: string | undefined
  if (!values.resume) {
    if (process.stdin.isTTY) throw new Error('Pipe the password through stdin; do not enter an echoed password or pass it as an argument.')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += Buffer.byteLength(chunk as Buffer)
      if (size > 1026) throw new Error('Password input exceeds 1024 bytes plus line ending.')
      chunks.push(Buffer.from(chunk as Buffer))
    }
    password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  }
  const user = await provisionUser(new CouchClient(loadConfig()), {
    login: values.login, displayName: values['display-name'], password, resume: values.resume,
  }, (step) => console.log(step))
  console.log(JSON.stringify({ login: user.login, userId: user.userId }))
} catch (error) {
  console.error(error instanceof CouchError ? `Internal database operation failed (${error.status}); previous completion steps are listed above.`
    : error instanceof Error ? error.message : 'User provisioning failed.')
  process.exitCode = 1
}

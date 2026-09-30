import { randomUUID } from 'node:crypto'
import { AUTH_DATABASE } from '../config.js'
import { hashPassword } from '../auth/passwords.js'
import { findUser, normalizeLogin, userDatabase, type User } from '../auth/users.js'
import { CouchError, type CouchClient } from './client.js'

export async function secureDatabase(couch: CouchClient, database: string): Promise<void> {
  try { await couch.request('PUT', `/${database}?q=1&n=1`) }
  catch (error) { if (!(error instanceof CouchError && error.status === 412)) throw error }
  await couch.request('PUT', `/${database}/_security`, {
    admins: { names: [couch.config.couchUsername], roles: ['_admin'] },
    members: { names: [couch.config.couchUsername], roles: ['_admin'] },
  })
}

export async function provisionUser(couch: CouchClient, input: {
  login: string; displayName?: string; password?: string; resume?: boolean
}, report: (step: string) => void = () => undefined): Promise<User> {
  const login = normalizeLogin(input.login)
  await secureDatabase(couch, AUTH_DATABASE)
  report('Authentication database ready')
  let user = await findUser(couch, login)
  if (user) {
    if (!input.resume || user.provisioned || user.enabled) throw new Error('Login already exists; no credentials changed. Only an incomplete disabled account may use --resume.')
    report(`Resuming incomplete user ${user.userId}; original password retained`)
  } else {
    if (input.resume) throw new Error('Cannot resume: login does not exist.')
    if (!input.displayName?.trim() || input.displayName.trim().length > 100) throw new Error('A display name of 1–100 characters is required.')
    user = {
      _id: `login:${login}`, type: 'user', userId: randomUUID(), login,
      displayName: input.displayName.trim(), enabled: false, provisioned: false,
      password: await hashPassword(input.password ?? ''), createdAt: new Date().toISOString(),
    }
    const result = await couch.put(AUTH_DATABASE, user._id, user)
    user._rev = result.rev
    report(`Disabled user record created: ${user.userId}`)
  }
  const database = userDatabase(user.userId)
  report(`Provisioning ${database}; failure leaves login disabled, retry with --resume`)
  await secureDatabase(couch, database)
  report('User database created and security applied')
  user = { ...user, enabled: true, provisioned: true }
  const result = await couch.put(AUTH_DATABASE, user._id, user)
  user._rev = result.rev
  report('User enabled')
  return user
}

import { createHash, randomBytes } from 'node:crypto'
import { AUTH_DATABASE } from '../config.js'
import { CouchError, type CouchClient } from '../couch/client.js'
import { findUser, type User } from './users.js'

export interface Session {
  _id: string
  _rev?: string
  type: 'session'
  userId: string
  login: string
  createdAt: string
  expiresAt: string
}

export function sessionId(token: string): string | null {
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? `session:${createHash('sha256').update(token).digest('hex')}` : null
}

export async function createSession(couch: CouchClient, user: User, maxAge: number, now = Date.now()): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const id = sessionId(token)!
  await couch.put(AUTH_DATABASE, id, {
    _id: id, type: 'session', userId: user.userId, login: user.login,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + maxAge * 1000).toISOString(),
  } satisfies Session)
  return token
}

export async function resolveSession(couch: CouchClient, token: string, now = Date.now()): Promise<User | null> {
  const id = sessionId(token)
  if (!id) return null
  const session = await couch.get<Session>(AUTH_DATABASE, id)
  if (!session || session.type !== 'session' || session._id !== id || !(Date.parse(session.expiresAt) > now)) return null
  const user = await findUser(couch, session.login)
  return user?.enabled === true && user.provisioned === true && user.userId === session.userId ? user : null
}

export async function revokeSession(couch: CouchClient, token: string): Promise<void> {
  const id = sessionId(token)
  if (!id) return
  const session = await couch.get<Session>(AUTH_DATABASE, id)
  if (!session) return
  try {
    await couch.request('DELETE', `/${AUTH_DATABASE}/${encodeURIComponent(id)}?rev=${encodeURIComponent(session._rev ?? '')}`)
  } catch (error) {
    if (!(error instanceof CouchError && [404, 409].includes(error.status))) throw error
    // Session documents are immutable, so a conflict means concurrent revocation.
  }
}

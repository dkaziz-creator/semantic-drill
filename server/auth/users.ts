import { AUTH_DATABASE } from '../config.js'
import type { CouchClient } from '../couch/client.js'
import type { PasswordHash } from './passwords.js'

export interface User {
  _id: string
  _rev?: string
  type: 'user'
  userId: string
  login: string
  displayName: string
  enabled: boolean
  provisioned: boolean
  password: PasswordHash
  createdAt: string
}

export function canonicalUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error('A canonical user UUID is required.')
  }
  return value
}

export function normalizeLogin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) throw new Error('Invalid login.')
  const login = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(login)) throw new Error('Invalid login.')
  return login
}

export function userDatabase(userId: string): string {
  return `semantic-drill-user-${canonicalUuid(userId)}`
}

export async function findUser(couch: CouchClient, login: string): Promise<User | null> {
  const id = `login:${normalizeLogin(login)}`
  const user = await couch.get<User>(AUTH_DATABASE, id)
  if (!user || user.type !== 'user' || user._id !== id || user.login !== login) return null
  canonicalUuid(user.userId)
  return user
}

export function publicIdentity(user: User): { id: string; displayName: string } {
  return { id: user.userId, displayName: user.displayName }
}

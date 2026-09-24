import { requireCondition } from './errors.js'
import { assertUserId, nonemptyString, timestamp } from './validation.js'

export type UserRole = 'admin' | 'student'
export type UserStatus = 'active' | 'disabled'

export interface Principal {
  userId: string
  role: UserRole
}

export interface UserRecord {
  id: string
  login: string
  displayName: string
  role: UserRole
  status: UserStatus
  auth: { type: 'unconfigured' } | { type: 'password'; passwordHash: string }
  leaderboard: { optIn: boolean; displayName?: string }
  createdAt: number
  updatedAt: number
}

export type PublicUser = Omit<UserRecord, 'auth'>

export function normalizeLogin(login: unknown): string {
  nonemptyString(login)
  const normalized = login.trim().toLowerCase()
  requireCondition(/^[a-z0-9][a-z0-9._@+-]{0,127}$/.test(normalized), 'Invalid login')
  return normalized
}

export function assertPrincipal(principal: Principal): void {
  assertUserId(principal?.userId)
  requireCondition(principal.role === 'admin' || principal.role === 'student', 'Invalid role')
}

export function validateUser(user: UserRecord): void {
  assertUserId(user.id)
  requireCondition(user.login === normalizeLogin(user.login), 'Login must be normalized')
  nonemptyString(user.displayName)
  requireCondition(['admin', 'student'].includes(user.role), 'Invalid role')
  requireCondition(['active', 'disabled'].includes(user.status), 'Invalid account status')
  requireCondition(user.auth.type === 'unconfigured' || user.auth.type === 'password', 'Invalid auth type')
  if (user.auth.type === 'password') nonemptyString(user.auth.passwordHash)
  requireCondition(typeof user.leaderboard.optIn === 'boolean', 'Invalid leaderboard preference')
  timestamp(user.createdAt)
  timestamp(user.updatedAt)
}

export function publicUser(user: UserRecord): PublicUser {
  return {
    id: user.id, login: user.login, displayName: user.displayName,
    role: user.role, status: user.status,
    leaderboard: {
      optIn: user.leaderboard.optIn,
      ...(user.leaderboard.displayName === undefined ? {} : { displayName: user.leaderboard.displayName }),
    },
    createdAt: user.createdAt, updatedAt: user.updatedAt,
  }
}

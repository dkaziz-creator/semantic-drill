import { requireCondition } from '../domain/errors.js'
import { assertUserId } from '../domain/validation.js'

export const databases = Object.freeze({
  users: 'semantic-drill-v2-users',
  catalog: 'semantic-drill-v2-catalog',
  answers: 'semantic-drill-v2-answers',
})

export function userDatabaseName(userId: string): string {
  assertUserId(userId)
  return `semantic-drill-v2-user-${userId}`
}

export function assertDatabaseName(database: string): void {
  if (Object.values(databases).some(name => name === database)) return
  requireCondition(typeof database === 'string' && database.startsWith('semantic-drill-v2-user-'), 'Not a v2 database')
  assertUserId(database.slice('semantic-drill-v2-user-'.length))
}

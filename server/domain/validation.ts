import { requireCondition } from './errors.js'

export function record(value: unknown): asserts value is Record<string, unknown> {
  requireCondition(typeof value === 'object' && value !== null && !Array.isArray(value), 'Expected an object')
}

export function onlyKeys(value: unknown, keys: readonly string[]): void {
  record(value)
  requireCondition(Object.keys(value).every(key => keys.includes(key)), 'Unexpected input field')
}

export function nonemptyString(value: unknown): asserts value is string {
  requireCondition(typeof value === 'string' && value.trim().length > 0, 'Expected a nonempty string')
}

export function optionalString(value: unknown): asserts value is string | undefined {
  requireCondition(value === undefined || typeof value === 'string', 'Expected a string')
}

export function uniqueStrings(value: unknown): asserts value is string[] {
  requireCondition(Array.isArray(value) && value.every(item => typeof item === 'string')
    && new Set(value).size === value.length, 'Expected distinct strings')
}

export function positiveInteger(value: unknown): asserts value is number {
  requireCondition(Number.isSafeInteger(value) && (value as number) > 0, 'Expected a positive integer')
}

export function timestamp(value: unknown): asserts value is number {
  requireCondition(Number.isSafeInteger(value) && (value as number) >= 0, 'Expected an epoch timestamp')
}

// Canonical lowercase UUIDs prevent differently cased identities aliasing a database.
export function assertUserId(value: unknown): asserts value is string {
  requireCondition(typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value),
  'Expected a canonical internal user UUID')
}

export function assertQuizId(value: unknown): asserts value is string {
  requireCondition(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value), 'Invalid quiz ID')
}

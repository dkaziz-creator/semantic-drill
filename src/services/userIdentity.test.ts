import { describe, expect, it } from 'vitest'
import { canonicalUserId, userScopedKey } from './userIdentity'
import { learningDatabaseName, openLearningDatabase } from './learningDatabase'

const USER = '550e8400-e29b-41d4-a716-446655440000'

describe('internal user namespaces', () => {
  it('canonicalizes UUID case for both IndexedDB and private preferences', () => {
    expect(canonicalUserId(USER.toUpperCase())).toBe(USER)
    expect(learningDatabaseName(USER.toUpperCase())).toBe(`semantic-drill-learning-${USER}`)
    expect(userScopedKey('drillmcq_ai_key.v1', USER.toUpperCase())).toBe(`drillmcq_ai_key.v1:${USER}`)
  })

  it.each([
    '', 'david', 'admin', '../../foo', '../' + USER, 'semantic-drill-learning-' + USER,
    USER + '/other', USER + '?db=admin', ' ' + USER, USER + '\n',
    '00000000-0000-0000-0000-000000000000', '550e8400-e29b-41d4-0716-446655440000',
    null, undefined, 123, {},
  ])('rejects invalid identities without echoing them: %j', (value) => {
    expect(() => canonicalUserId(value)).toThrow('A valid internal user UUID is required.')
    if (typeof value === 'string') {
      expect(() => openLearningDatabase(value)).toThrow('A valid internal user UUID is required.')
      expect(() => userScopedKey('key', value)).toThrow('A valid internal user UUID is required.')
    }
  })
})

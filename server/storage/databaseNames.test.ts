import { expect, it } from 'vitest'
import { assertDatabaseName, userDatabaseName } from './databaseNames.js'
import { alice } from '../test/fixtures.js'

it('derives a deterministic database from a canonical internal UUID', () => {
  expect(userDatabaseName(alice.userId)).toBe(`semantic-drill-v2-user-${alice.userId}`)
})

it.each(['../../foo', 'admin', 'semantic-drill-v2-catalog', 'semantic-drill-learning', '',
  `${alice.userId}/../../foo`, 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', '00000000-0000-0000-0000-000000000000',
])('rejects noncanonical user DB identity %s', value => {
  expect(() => userDatabaseName(value)).toThrow()
})

it.each(['semantic-drill-learning', 'semantic-drill-v2-arbitrary', 'semantic-drill-v2-user-admin'])('blocks non-v2 DB access: %s', value => {
  expect(() => assertDatabaseName(value)).toThrow()
})

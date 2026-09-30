import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

export interface PasswordHash {
  algorithm: 'scrypt'
  salt: string
  hash: string
  cost: { N: number; r: number; p: number }
}

export const PASSWORD_COST = { N: 32768, r: 8, p: 1 }
const LENGTH = 64
const MAXMEM = 128 * 1024 * 1024
const DUMMY: PasswordHash = {
  algorithm: 'scrypt', salt: '00'.repeat(32), hash: '00'.repeat(LENGTH), cost: PASSWORD_COST,
}

export function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value, 'utf8') <= 1024
}

function validHash(value: unknown): value is PasswordHash {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<PasswordHash>
  const c = v.cost
  return v.algorithm === 'scrypt' && typeof v.salt === 'string' && /^[a-f0-9]{64}$/.test(v.salt) &&
    typeof v.hash === 'string' && /^[a-f0-9]{128}$/.test(v.hash) && !!c &&
    Number.isInteger(c.N) && c.N >= 16384 && c.N <= 65536 && (c.N & (c.N - 1)) === 0 &&
    c.r === 8 && Number.isInteger(c.p) && c.p >= 1 && c.p <= 2
}

function derive(password: string, record: PasswordHash): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, Buffer.from(record.salt, 'hex'), LENGTH, { ...record.cost, maxmem: MAXMEM },
      (error, key) => error ? reject(error) : resolve(key))
  })
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  if (!validPassword(password)) throw new Error('Password must contain at least 12 characters and at most 1024 UTF-8 bytes.')
  const result = { ...DUMMY, salt: randomBytes(32).toString('hex'), cost: { ...PASSWORD_COST } }
  result.hash = (await derive(password, result)).toString('hex')
  return result
}

export async function verifyPassword(password: string, stored: unknown): Promise<boolean> {
  if (!validPassword(password)) return false
  const valid = validHash(stored)
  // Unknown accounts and malformed records perform the same default derivation.
  const record = valid ? stored : DUMMY
  const candidate = await derive(password, record)
  const matches = timingSafeEqual(candidate, Buffer.from(record.hash, 'hex'))
  return valid && matches
}

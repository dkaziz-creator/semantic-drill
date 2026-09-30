export interface Config {
  host: string
  port: number
  publicOrigin: string
  couchUrl: string
  couchUsername: string
  couchPassword: string
  cookieSecure: boolean
  sessionMaxAge: number
}

export const AUTH_DATABASE = 'semantic-drill-study-auth'

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name]
    if (!value) throw new Error(`Missing required configuration: ${name}`)
    return value
  }
  const url = (name: string): URL => {
    try {
      const parsed = new URL(required(name))
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error()
      return parsed
    } catch { throw new Error(`Invalid configuration: ${name} (HTTP(S) origin without credentials required)`) }
  }
  const integer = (name: string, fallback: number, max: number): number => {
    const value = Number(env[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid configuration: ${name}`)
    return value
  }
  const publicUrl = url('STUDY_PUBLIC_ORIGIN')
  const couch = url('COUCHDB_INTERNAL_URL')
  const secureSetting = env.SESSION_COOKIE_SECURE ?? 'true'
  if (!['true', 'false'].includes(secureSetting)) throw new Error('Invalid configuration: SESSION_COOKIE_SECURE')
  const cookieSecure = secureSetting === 'true'
  if ((!cookieSecure || publicUrl.protocol !== 'https:') && env.NODE_ENV !== 'development') {
    throw new Error('Production requires HTTPS STUDY_PUBLIC_ORIGIN and SESSION_COOKIE_SECURE=true')
  }
  const couchUsername = required('COUCHDB_USERNAME')
  if (/[:\r\n]/.test(couchUsername)) throw new Error('Invalid configuration: COUCHDB_USERNAME')
  return {
    host: env.STUDY_BIND_HOST || '127.0.0.1',
    port: integer('STUDY_PORT', 3000, 65535),
    publicOrigin: publicUrl.origin,
    couchUrl: couch.origin,
    couchUsername,
    couchPassword: required('COUCHDB_PASSWORD'),
    cookieSecure,
    sessionMaxAge: integer('SESSION_MAX_AGE_SECONDS', 604800, 2592000),
  }
}

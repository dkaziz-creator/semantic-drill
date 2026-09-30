import type { Config } from '../config.js'

export function sessionCookie(header?: string): string {
  const matches = (header ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith('study_session='))
  return matches.length === 1 ? matches[0]!.slice('study_session='.length) : ''
}

export function cookie(token: string, config: Config, clear = false): string {
  return `study_session=${clear ? '' : token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : config.sessionMaxAge}${config.cookieSecure ? '; Secure' : ''}`
}

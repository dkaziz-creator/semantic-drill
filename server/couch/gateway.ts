import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import { userDatabase } from '../auth/users.js'
import { HttpError, json } from '../http/security.js'
import type { CouchClient } from './client.js'

const special: Record<string, readonly string[]> = {
  _changes: ['GET', 'POST'], _all_docs: ['GET', 'POST'], _bulk_docs: ['POST'],
  _revs_diff: ['POST'], _bulk_get: ['POST'],
}

/** Inspect the raw request target before any URL library can normalize dot segments. */
export function gatewayPath(target: string, method: string, userId: string): string {
  const database = userDatabase(userId)
  const question = target.indexOf('?')
  const path = question < 0 ? target : target.slice(0, question)
  const query = question < 0 ? '' : target.slice(question)
  if (!path.startsWith('/couchdb/my/') && path !== '/couchdb/my') throw new HttpError(404, 'Unknown route.')
  const suffix = path.slice('/couchdb/my'.length)
  // Control characters must be rejected in raw and decoded request paths.
  // eslint-disable-next-line no-control-regex
  if (/[\\#\u0000-\u0020\u007f]/.test(target)) throw new HttpError(400, 'Invalid path.')
  let parts: string[]
  try { parts = suffix.replace(/^\//, '').split('/').map((part) => decodeURIComponent(part)) }
  catch { throw new HttpError(400, 'Invalid path encoding.') }
  // eslint-disable-next-line no-control-regex
  if (parts.some((part) => part === '.' || part === '..' || /[%/\\?#\u0000-\u0020\u007f]/.test(part)) ||
    (parts.length > 1 && parts.some((part) => !part))) throw new HttpError(400, 'Invalid path.')
  const first = parts[0] ?? ''
  let methods: readonly string[]
  if (!first) methods = ['GET', 'HEAD'] // never create/delete a DB through the browser
  else if (first === '_local' && parts.length === 2) methods = ['GET', 'HEAD', 'PUT', 'DELETE']
  else if (first.startsWith('_')) methods = parts.length === 1 ? (special[first] ?? []) : []
  else methods = ['GET', 'HEAD', 'PUT', 'DELETE']
  if (!methods.includes(method)) throw new HttpError(403, 'Operation unavailable through this gateway.')
  return `/${database}${suffix || '/'}${query}`
}

const requestHeaders = new Set([
  'accept', 'accept-encoding', 'content-type', 'content-length', 'content-encoding',
  'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'range', 'if-range', 'x-couch-full-commit',
])
const responseHeaders = new Set([
  'content-type', 'content-length', 'content-encoding', 'content-range', 'accept-ranges',
  'etag', 'last-modified', 'vary', 'x-couch-request-id', 'x-couch-update-newrev',
])

export function createGateway(couch: CouchClient) {
  // Metadata uses a separate pool so 50 long polls cannot starve authentication.
  const secure = couch.config.couchUrl.startsWith('https:')
  const agent = secure ? new https.Agent({ keepAlive: true, maxSockets: 256 }) : new http.Agent({ keepAlive: true, maxSockets: 256 })

  function proxy(request: IncomingMessage, response: ServerResponse, path: string): void {
    const headers: http.OutgoingHttpHeaders = { authorization: couch.authorization }
    const hopHeaders = new Set((request.headers.connection ?? '').toLowerCase().split(',').map((v) => v.trim()))
    for (const [key, value] of Object.entries(request.headers)) {
      if (requestHeaders.has(key) && !hopHeaders.has(key)) headers[key] = value
    }
    const upstream = (secure ? https : http).request(couch.config.couchUrl, {
      method: request.method, path, headers, agent,
    }, (incoming) => {
      // CouchDB JSON and streams stay byte-for-byte native. Auth cookies and redirects stay private.
      const outgoing: http.OutgoingHttpHeaders = { 'cache-control': 'no-store', 'x-accel-buffering': 'no' }
      const hops = new Set((incoming.headers.connection ?? '').toLowerCase().split(',').map((v) => v.trim()))
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (responseHeaders.has(key) && !hops.has(key)) outgoing[key] = value
      }
      response.writeHead(incoming.statusCode ?? 502, outgoing)
      response.flushHeaders()
      incoming.on('error', () => response.destroy())
      incoming.on('aborted', () => response.destroy())
      response.on('close', () => incoming.destroy())
      incoming.pipe(response)
    })
    // Limit connecting, not the lifetime or idle time of authorized long polls.
    const connectTimer = setTimeout(() => upstream.destroy(new Error('Connect timeout')), 5000)
    connectTimer.unref()
    upstream.on('socket', (socket) => {
      if (!socket.connecting) clearTimeout(connectTimer)
      else socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer))
    })
    upstream.on('error', () => {
      clearTimeout(connectTimer)
      if (!response.headersSent && !response.destroyed) json(response, 502, { error: 'Study database unavailable.' })
      else response.destroy()
    })
    upstream.on('close', () => clearTimeout(connectTimer))
    response.on('close', () => upstream.destroy())
    request.on('aborted', () => upstream.destroy())
    request.on('error', () => upstream.destroy())
    request.pipe(upstream)
  }
  return { proxy, close: () => agent.destroy() }
}

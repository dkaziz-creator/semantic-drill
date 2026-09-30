import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError } from './security.js'

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
}

export async function serveStatic(request: IncomingMessage, response: ServerResponse, directory: string): Promise<void> {
  if (!['GET', 'HEAD'].includes(request.method ?? '')) throw new HttpError(404, 'Unknown route.')
  let pathname: string
  try { pathname = decodeURIComponent((request.url ?? '/').split('?')[0]!) }
  catch { throw new HttpError(400, 'Invalid path.') }
  const parts = pathname.split('/').filter(Boolean)
  if (parts.some((p) => p.startsWith('.') || p.includes('\\') || p.includes('\0'))) throw new HttpError(404, 'Unknown route.')
  // This app has no browser-side routes. Serve only actual dist files.
  const file = resolve(directory, '.' + (pathname === '/' ? '/index.html' : pathname))
  if (!file.startsWith(resolve(directory) + '/')) throw new HttpError(404, 'Unknown route.')
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) throw new HttpError(404, 'Unknown route.')
  response.writeHead(200, {
    'Content-Type': types[extname(file)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (request.method === 'HEAD') { response.end(); return }
  const stream = createReadStream(file)
  stream.on('error', () => response.destroy())
  response.on('close', () => stream.destroy())
  stream.pipe(response)
}

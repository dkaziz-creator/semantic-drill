import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from '../config.js'

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export function checkOrigin(request: IncomingMessage, config: Config): void {
  const origin = request.headers.origin
  if ((origin !== undefined && origin !== config.publicOrigin) || request.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'Same-origin request required.')
  }
}

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'JSON required.')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  const timer = setTimeout(() => request.destroy(), 10000)
  timer.unref()
  try {
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk as Buffer)
      if (bytes > 4096) throw new HttpError(413, 'Request too large.')
      chunks.push(Buffer.from(chunk as Buffer))
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
    catch { throw new HttpError(400, 'Invalid JSON.') }
  } finally { clearTimeout(timer) }
}

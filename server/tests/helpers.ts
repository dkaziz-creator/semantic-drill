import { createServer, type Server, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Config } from '../config.js'

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

export async function close(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeAllConnections()
  await closed
}

export function testConfig(couchUrl: string): Config {
  return { host: '127.0.0.1', port: 3000, publicOrigin: 'https://study.example',
    couchUrl, couchUsername: 'backend', couchPassword: 'test-only-internal-password', cookieSecure: true, sessionMaxAge: 604800 }
}

type Doc = Record<string, unknown> & { _id: string; _rev?: string }
export function fakeCouch() {
  const databases = new Map<string, Map<string, Doc>>()
  const chunksSeen: { path: string; chunk: string }[] = []
  const faults = { userSecurity: false }
  const securities = new Map<string, unknown>()
  const requests: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] = []
  const streams: { database: string; response: ServerResponse }[] = []
  let revision = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk as Buffer))
      chunksSeen.push({ path: request.url ?? '', chunk: Buffer.from(chunk as Buffer).toString() })
    }
    const raw = Buffer.concat(chunks).toString()
    const method = request.method ?? ''
    requests.push({ method, path: request.url ?? '', headers: request.headers, body: raw })
    const url = new URL(request.url!, 'http://internal')
    const [database = '', ...parts] = url.pathname.slice(1).split('/').map(decodeURIComponent)
    const id = parts.join('/')
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ETag: '"native-revision"',
        'Set-Cookie': 'AuthSession=must-not-leak', 'Access-Control-Allow-Origin': '*' })
      response.end(JSON.stringify(value))
    }
    let db = databases.get(database)
    if (!id && method === 'PUT') {
      if (db) { send(412, { error: 'file_exists' }); return }
      db = new Map(); databases.set(database, db); send(201, { ok: true }); return
    }
    if (!db) { send(404, { error: 'not_found', reason: 'Database does not exist.' }); return }
    if (!id) { send(200, { db_name: database, update_seq: revision, doc_count: db.size }); return }
    if (id === '_security') {
      if (faults.userSecurity && database.startsWith('semantic-drill-user-')) { send(503, { error: 'unavailable' }); return }
      if (method === 'PUT') securities.set(database, JSON.parse(raw))
      send(200, method === 'PUT' ? { ok: true } : securities.get(database)); return
    }
    if (id === '_changes') {
      if (url.searchParams.get('feed') === 'longpoll') {
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('\n')
        streams.push({ database, response }); return
      }
      send(200, { results: [], last_seq: revision }); return
    }
    if (id === '_all_docs') {
      send(200, { total_rows: db.size, rows: [...db.values()].map((doc) => ({ id: doc._id, key: doc._id, doc, value: { rev: doc._rev } })) }); return
    }
    if (id === '_revs_diff') { send(200, JSON.parse(raw)); return }
    if (id === '_bulk_get') {
      const body = JSON.parse(raw) as { docs: { id: string }[] }
      send(200, { results: body.docs.map(({ id }) => ({ id, docs: [{ ok: db.get(id) }] })) }); return
    }
    const put = (doc: Doc) => {
      const previous = db.get(doc._id)
      if (previous && previous._rev !== doc._rev) return { error: 'conflict', id: doc._id }
      const rev = `${++revision}-test`
      db.set(doc._id, { ...doc, _rev: rev }); return { ok: true, id: doc._id, rev }
    }
    if (id === '_bulk_docs') { send(201, (JSON.parse(raw) as { docs: Doc[] }).docs.map(put)); return }
    if (method === 'PUT') {
      const result = put({ ...JSON.parse(raw), _id: id } as Doc)
      send(result.error ? 409 : 201, result); return
    }
    const doc = db.get(id)
    if (!doc) { send(404, { error: 'not_found' }); return }
    if (method === 'DELETE') {
      if (url.searchParams.get('rev') !== doc._rev) { send(409, { error: 'conflict' }); return }
      db.delete(id); send(200, { ok: true }); return
    }
    send(200, doc)
  })
  return { server, databases, securities, requests, streams, chunksSeen, faults }
}

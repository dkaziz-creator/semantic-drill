/** Deterministic HTTP protocol fake, not a replacement for a live CouchDB integration test. */
export class FakeCouch {
  readonly databases = new Map<string, Map<string, Record<string, unknown>>>()
  readonly security = new Map<string, unknown>()
  readonly requests: { url: URL; init: RequestInit }[] = []
  failNext?: { database: string; id: string; status: number }
  private revision = 0

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    this.requests.push({ url, init })
    const [database, id] = url.pathname.slice(1).split('/').map(decodeURIComponent)
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status })
    if (this.failNext?.database === database && this.failNext.id === id) {
      const status = this.failNext.status
      this.failNext = undefined
      return reply(status, { error: 'injected failure' })
    }
    if (init.method === 'PUT' && id === undefined) {
      if (this.databases.has(database)) return reply(412, { error: 'file_exists' })
      this.databases.set(database, new Map())
      return reply(201, { ok: true })
    }
    const db = this.databases.get(database)
    if (!db) return reply(404, { error: 'not_found' })
    if (id === '_security' && init.method === 'PUT') {
      this.security.set(database, JSON.parse(String(init.body)))
      return reply(200, { ok: true })
    }
    if (id === '_all_docs') {
      const start = JSON.parse(url.searchParams.get('startkey') ?? '""') as string
      const end = JSON.parse(url.searchParams.get('endkey') ?? '"\\ufff0"') as string
      const rows = [...db].filter(([key]) => key >= start && key <= end)
        .map(([key, doc]) => ({ id: key, key, doc }))
      return reply(200, { total_rows: db.size, rows })
    }
    if (init.method === 'PUT') {
      const document = JSON.parse(String(init.body)) as Record<string, unknown>
      const previous = db.get(id)
      if (previous ? previous._rev !== document._rev : document._rev !== undefined) {
        return reply(409, { error: 'conflict' })
      }
      const rev = `${++this.revision}-test`
      db.set(id, { ...document, _id: id, _rev: rev })
      return reply(201, { ok: true, id, rev })
    }
    const document = db.get(id)
    return document ? reply(200, document) : reply(404, { error: 'not_found' })
  }
}

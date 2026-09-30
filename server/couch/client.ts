import type { Config } from '../config.js'

export class CouchError extends Error {
  constructor(readonly status: number) { super(`Internal database request failed (${status}).`) }
}

/** Only bounded, trusted metadata requests use JSON. Replication never uses this client. */
export class CouchClient {
  readonly authorization: string
  constructor(readonly config: Config) {
    this.authorization = `Basic ${Buffer.from(`${config.couchUsername}:${config.couchPassword}`).toString('base64')}`
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await fetch(this.config.couchUrl + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new CouchError(response.status)
      }
      return await response.json() as T
    } catch (error) {
      if (error instanceof CouchError) throw error
      throw new CouchError(503)
    }
  }

  async get<T>(database: string, id: string): Promise<T | null> {
    try { return await this.request<T>('GET', `/${database}/${encodeURIComponent(id)}`) }
    catch (error) {
      if (error instanceof CouchError && error.status === 404) return null
      throw error
    }
  }

  put(database: string, id: string, value: unknown): Promise<{ rev: string }> {
    return this.request('PUT', `/${database}/${encodeURIComponent(id)}`, value)
  }
}

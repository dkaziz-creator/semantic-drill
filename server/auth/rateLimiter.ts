/** Fixed windows, bounded cardinality, fail closed when full; never trust forwarded IP headers. */
export class LoginLimiter {
  private readonly entries = new Map<string, { count: number; expires: number }>()
  constructor(readonly maxEntries = 4096, readonly windowMs = 300000) {}

  take(address: string, login: string, now = Date.now()): boolean {
    for (const [key, value] of this.entries) if (value.expires <= now) this.entries.delete(key)
    const keys = [[`ip:${address}`, 100], [`pair:${address}:${login}`, 10]] as const
    if (this.entries.size + keys.filter(([key]) => !this.entries.has(key)).length > this.maxEntries) return false
    for (const [key, max] of keys) {
      const existing = this.entries.get(key)
      if ((!existing && this.entries.size >= this.maxEntries) || (existing && existing.count >= max)) return false
    }
    for (const [key] of keys) {
      const entry = this.entries.get(key) ?? { count: 0, expires: now + this.windowMs }
      entry.count++
      this.entries.set(key, entry)
    }
    return true
  }

  success(address: string, login: string): void { this.entries.delete(`pair:${address}:${login}`) }
  get size(): number { return this.entries.size }
}

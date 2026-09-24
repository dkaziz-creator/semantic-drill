/** Opaque optimistic concurrency token; kept out of public quiz/attempt DTOs. */
export interface Versioned<T> { value: T; revision: string }

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { DomainError } from '../../domain/errors.js'
import { answerKey, publicQuiz } from '../../domain/quizzes.js'
import type { QuizAnswerKey, QuizDefinition } from '../../domain/quizzes.js'
import type { DocumentStore, StoredDocument } from '../DocumentStore.js'
import { assertQuizId, positiveInteger } from '../../domain/validation.js'

export function quizDocumentId(quizId: string, version: number): string {
  assertQuizId(quizId)
  positiveInteger(version)
  return `${quizId}:v${version}`
}

export function document<T>(type: StoredDocument<T>['type'], value: T): StoredDocument<T> {
  return { schemaVersion: 2, type, value }
}

/** A failed catalog write can be retried with identical content; a version can never acquire a different key. */
export async function reserveAnswerKey(
  store: DocumentStore, database: string, id: string, quiz: QuizDefinition,
  key: QuizAnswerKey, type: 'answer-key' | 'user-answer-key',
): Promise<void> {
  const canonical = publicQuiz(quiz)
  // Publication timestamps may change between retries; all content and source fields stay bound.
  const { createdAt, publishedAt, ...content } = canonical
  void createdAt
  void publishedAt
  const contentHash = createHash('sha256').update(JSON.stringify(content)).digest('hex')
  const value = answerKey(key)
  try {
    await store.create(database, id, { ...document(type, value), contentHash })
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'CONFLICT') throw error
    const existing = await store.get<QuizAnswerKey>(database, id)
    if (existing?.value.type !== type || existing.value.contentHash !== contentHash
      || !isDeepStrictEqual(existing.value.value, value)) {
      throw new DomainError('CONFLICT', 'Quiz version is already reserved with different content or answers')
    }
  }
}

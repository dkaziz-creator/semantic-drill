import { requireCondition } from '../../domain/errors.js'
import { answerKey, privateQuiz, validateQuizPair } from '../../domain/quizzes.js'
import type { QuizAnswerKey, UserQuiz } from '../../domain/quizzes.js'
import { assertPrincipal } from '../../domain/users.js'
import type { Principal } from '../../domain/users.js'
import type { UserQuizRepository } from '../../repositories/UserQuizRepository.js'
import type { DocumentStore } from '../DocumentStore.js'
import { userDatabaseName } from '../databaseNames.js'
import { document, quizDocumentId, reserveAnswerKey } from './helpers.js'

export class StoredUserQuizRepository implements UserQuizRepository {
  constructor(private readonly store: DocumentStore) {}

  private database(principal: Principal): string {
    assertPrincipal(principal)
    return userDatabaseName(principal.userId)
  }

  async create(principal: Principal, quiz: UserQuiz, key: QuizAnswerKey): Promise<void> {
    const database = this.database(principal)
    validateQuizPair(quiz, key)
    requireCondition(quiz.source.type === 'user' && quiz.source.ownerUserId === principal.userId, 'Private quiz owner must match principal')
    requireCondition(['draft', 'private', 'pending-review'].includes(quiz.status) && quiz.publishedAt === undefined, 'Invalid private quiz status')
    const id = quizDocumentId(quiz.id, quiz.version)
    await reserveAnswerKey(this.store, database, `user-answer-key:${id}`, quiz, key, 'user-answer-key')
    await this.store.create(database, `user-quiz:${id}`, document('user-quiz', privateQuiz(quiz)))
  }

  async list(principal: Principal): Promise<UserQuiz[]> {
    return (await this.store.list<UserQuiz>(this.database(principal), 'user-quiz:'))
      .filter(doc => doc.value.type === 'user-quiz' && doc.value.value.source.ownerUserId === principal.userId)
      .map(doc => privateQuiz(doc.value.value))
  }

  async get(principal: Principal, quizId: string, version: number): Promise<UserQuiz | undefined> {
    const doc = await this.store.get<UserQuiz>(this.database(principal), `user-quiz:${quizDocumentId(quizId, version)}`)
    return doc?.value.type === 'user-quiz' && doc.value.value.source.ownerUserId === principal.userId ? privateQuiz(doc.value.value) : undefined
  }

  async getAnswerKey(principal: Principal, quizId: string, version: number): Promise<QuizAnswerKey | undefined> {
    // Also require the owner's content document; never expose an orphaned key.
    if (!await this.get(principal, quizId, version)) return undefined
    const doc = await this.store.get<QuizAnswerKey>(this.database(principal), `user-answer-key:${quizDocumentId(quizId, version)}`)
    return doc?.value.type === 'user-answer-key' ? answerKey(doc.value.value) : undefined
  }
}

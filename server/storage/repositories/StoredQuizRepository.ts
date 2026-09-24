import { requireCondition } from '../../domain/errors.js'
import { answerKey, publicQuiz, validateQuizPair } from '../../domain/quizzes.js'
import type { QuizAnswerKey, QuizDefinition } from '../../domain/quizzes.js'
import type { QuizRepository } from '../../repositories/QuizRepository.js'
import type { DocumentStore } from '../DocumentStore.js'
import { databases } from '../databaseNames.js'
import { document, quizDocumentId, reserveAnswerKey } from './helpers.js'

export class StoredQuizRepository implements QuizRepository {
  constructor(private readonly store: DocumentStore) {}

  async publish(quiz: QuizDefinition, key: QuizAnswerKey): Promise<void> {
    validateQuizPair(quiz, key)
    requireCondition(quiz.source.type === 'admin' && quiz.publishedAt !== undefined, 'Only admin shared quizzes can be published')
    const id = quizDocumentId(quiz.id, quiz.version)
    await reserveAnswerKey(this.store, databases.answers, `answer-key:${id}`, quiz, key, 'answer-key')
    await this.store.create(databases.catalog, `quiz:${id}`, document('quiz', publicQuiz(quiz)))
  }

  async listPublished(): Promise<QuizDefinition[]> {
    return (await this.store.list<QuizDefinition>(databases.catalog, 'quiz:'))
      .filter(doc => doc.value.type === 'quiz' && doc.value.value.publishedAt !== undefined)
      .map(doc => publicQuiz(doc.value.value))
  }

  async getPublished(quizId: string, version: number): Promise<QuizDefinition | undefined> {
    const doc = await this.store.get<QuizDefinition>(databases.catalog, `quiz:${quizDocumentId(quizId, version)}`)
    return doc?.value.type === 'quiz' && doc.value.value.publishedAt !== undefined ? publicQuiz(doc.value.value) : undefined
  }

  async getAnswerKey(quizId: string, version: number): Promise<QuizAnswerKey | undefined> {
    const doc = await this.store.get<QuizAnswerKey>(databases.answers, `answer-key:${quizDocumentId(quizId, version)}`)
    return doc?.value.type === 'answer-key' ? answerKey(doc.value.value) : undefined
  }
}

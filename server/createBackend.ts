import { defaultFeatures } from './config/features.js'
import type { ServerFeatures } from './config/features.js'
import { AttemptService } from './services/AttemptService.js'
import { AuthorizationService } from './services/AuthorizationService.js'
import { QuizService } from './services/QuizService.js'
import { UserQuizService } from './services/UserQuizService.js'
import { UserService } from './services/UserService.js'
import type { DocumentStore } from './storage/DocumentStore.js'
import { databases } from './storage/databaseNames.js'
import { StoredAttemptRepository } from './storage/repositories/StoredAttemptRepository.js'
import { StoredQuizRepository } from './storage/repositories/StoredQuizRepository.js'
import { StoredUserQuizRepository } from './storage/repositories/StoredUserQuizRepository.js'
import { StoredUserRepository } from './storage/repositories/StoredUserRepository.js'

/** Explicit server composition, with no startup side effects or imports from v1/browser storage. */
export function createBackend(store: DocumentStore, options: { features?: ServerFeatures; now?: () => number } = {}) {
  const features = Object.freeze({ ...(options.features ?? defaultFeatures) })
  const repositories = {
    users: new StoredUserRepository(store), quizzes: new StoredQuizRepository(store),
    attempts: new StoredAttemptRepository(store), userQuizzes: new StoredUserQuizRepository(store),
  }
  const authorization = new AuthorizationService(repositories.users)
  return {
    features,
    // Trusted server composition/bootstrap only; never expose raw repositories via HTTP.
    repositories,
    services: {
      users: new UserService(repositories.users, authorization, options.now),
      quizzes: new QuizService(repositories.quizzes, authorization, options.now),
      attempts: new AttemptService(repositories.attempts, repositories.quizzes, repositories.userQuizzes, authorization, features, options.now),
      userQuizzes: new UserQuizService(repositories.userQuizzes, authorization, features, options.now),
    },
    async initialize(): Promise<void> {
      for (const database of Object.values(databases)) await store.provision(database)
    },
  }
}

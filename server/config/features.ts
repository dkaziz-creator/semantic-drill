export interface ServerFeatures { readonly userQuizzesEnabled: boolean }

export const defaultFeatures: ServerFeatures = Object.freeze({ userQuizzesEnabled: false })

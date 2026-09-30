import { useState, type FormEvent, type ReactNode } from 'react'
import type { AuthenticatedUser } from '../services/userIdentity'

export function StudyLogin({ onSignIn, error }: {
  onSignIn: (login: string, password: string) => Promise<void>
  error?: string
}) {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    const secret = password
    setPassword('')
    void onSignIn(login, secret).catch(() => undefined)
  }

  return <main className="min-h-screen bg-slate-50 px-6 py-20 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
    <form onSubmit={submit} className="mx-auto flex max-w-sm flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <h1 className="mb-2 text-2xl font-semibold">Semantic Drill</h1>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <label className="flex flex-col gap-1 text-sm">Login
        <input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={64}
          value={login} onChange={(event) => setLogin(event.target.value)} disabled={pending}
          className="rounded-lg border border-slate-300 p-2 dark:border-slate-600" />
      </label>
      <label className="flex flex-col gap-1 text-sm">Password
        <input name="password" type="password" autoComplete="current-password" required maxLength={1024}
          value={password} onChange={(event) => setPassword(event.target.value)} disabled={pending}
          className="rounded-lg border border-slate-300 p-2 dark:border-slate-600" />
      </label>
      <button type="submit" disabled={pending} className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-60">
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  </main>
}

export function StudyAccount({ user, onSignOut, children }: {
  user: AuthenticatedUser
  onSignOut: () => Promise<void>
  children: ReactNode
}) {
  return <>
    <div className="flex items-center justify-end gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
      <span>{user.displayName ?? 'Study account'}</span>
      <button type="button" onClick={() => { void onSignOut().catch(() => undefined) }} className="rounded border border-slate-300 px-3 py-1 dark:border-slate-600">Sign out</button>
    </div>
    {children}
  </>
}

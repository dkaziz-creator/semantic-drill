import { useState, type FormEvent } from 'react'

export function StudyChangePassword({ onChangePassword, onSignOut, error }: {
  onChangePassword: (password: string) => Promise<void>
  onSignOut: () => Promise<void>
  error?: string
}) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [validationError, setValidationError] = useState('')
  const [pending, setPending] = useState(false)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    if (password !== confirmation) {
      setValidationError('Passwords do not match.')
      return
    }
    setPending(true)
    const secret = password
    setPassword('')
    setConfirmation('')
    void onChangePassword(secret).catch(() => undefined)
  }

  return <main className="min-h-screen bg-slate-50 px-6 py-20 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
    <form onSubmit={submit} className="mx-auto flex max-w-sm flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <h1 className="mb-2 text-2xl font-semibold">Change your password</h1>
      <p className="text-sm">Choose a new password to start studying. Use at least 12 characters and a password different from your temporary password.</p>
      {(validationError || error) && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{validationError || error}</p>}
      <label className="flex flex-col gap-1 text-sm">New password
        <input name="new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={1024}
          value={password} onChange={(event) => { setPassword(event.target.value); setValidationError('') }} disabled={pending}
          className="rounded-lg border border-slate-300 p-2 dark:border-slate-600" />
      </label>
      <label className="flex flex-col gap-1 text-sm">Confirm new password
        <input name="confirm-password" type="password" autoComplete="new-password" required minLength={12} maxLength={1024}
          value={confirmation} onChange={(event) => { setConfirmation(event.target.value); setValidationError('') }} disabled={pending}
          className="rounded-lg border border-slate-300 p-2 dark:border-slate-600" />
      </label>
      <button type="submit" disabled={pending} className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-60">
        {pending ? 'Changing password…' : 'Change password'}
      </button>
      <button type="button" disabled={pending} onClick={() => {
        setPending(true)
        setPassword('')
        setConfirmation('')
        void onSignOut().catch(() => undefined)
      }} className="rounded-lg border border-slate-300 px-4 py-2 dark:border-slate-600 disabled:opacity-60">Cancel and sign out</button>
    </form>
  </main>
}

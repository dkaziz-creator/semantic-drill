# User-scoped study storage pilot

This branch is based on `server-release`, not `server-collegues`. It implements
browser storage isolation and the authentication/gateway seam. It does not
implement the future authentication server, final login UI, database provisioner,
quiz distribution, or exam/ranked mode. No runtime dependency was added.

## Identity and startup

`getAuthenticatedUser()` in `src/services/authentication.ts` obtains:

```json
{"id":"550e8400-e29b-41d4-a716-446655440000","displayName":"David"}
```

The default provider requests `GET /api/auth/me` with same-origin session
credentials, `Accept: application/json`, no caching and no redirects. The future
server must authenticate the session, return its **server-owned internal UUID**,
and use `Cache-Control: no-store`. Reject unauthenticated requests with 401;
never return a shared guest identity. Display names are optional and never used
for storage selection. A UUID's syntax is validated in the client, but only the
server can establish ownership of it.

For local development only, set `VITE_DEV_USER_ID` to an explicit test UUID in
`.env.local`, then run `npm run dev`. The fixture is ignored by production builds.
It does not authenticate with CouchDB or provision a remote account. Leave sync
blank for local tests. If testing with a gateway, the fixture must match the real
server session UUID. There is no identity from query parameters or localStorage,
no automatically generated identity, and no anonymous legacy fallback.

Startup is: resolve identity → validate/canonicalize UUID → open local database →
start optional native sync → mount the existing App. Authentication failure
leaves the app unmounted with a sanitized retry message. Once authenticated and
opened, remote sync failure does not interrupt local study. A production cold
start currently needs `/api/auth/me`; offline identity caching is not implemented.

## Local names and unchanged documents

`openLearningDatabase(userId)` accepts a UUID, never a full database name. It
validates the UUID version/variant and converts it to lowercase:

```text
semantic-drill-learning-550e8400-e29b-41d4-a716-446655440000
```

The existing `semantic-drill-learning` database and all unowned v1 localStorage
learning data are left untouched. Nothing is copied, deleted or automatically
migrated into a study namespace. `initializeLegacyStorage({ database })` retains
the explicit v1 maintenance/test path and its existing normalization/migration
coverage; the application bootstrap never calls it.

Each user keeps the current complete document contract:

| Document ID | Stored payload |
| --- | --- |
| `quiz:<id>` | `{ type: 'quiz', order, value: SavedQuiz }` |
| `attempt:<id>` | `{ type: 'attempt', order, value: QuizAttempt }` |
| `session:active` | `{ type: 'session', order, value: QuizSession }` |

PouchDB adds `_id`/`_rev`. Existing `questions`, `correctAnswers`, explanations,
progress, reveals, settings, scoring, history and resume behavior remain intact.
No domain schema version bump is needed. Future trusted distribution can insert
these same wrapped `quiz:<id>` documents into each user's CouchDB; the browser
already processes them like any other saved quiz. Distribution is not included.

## Account changes

The bootstrap exported as `studyApplication` from `src/main.tsx` exposes:

```ts
await studyApplication.changeAccount(async () => {
  // Only here: perform the future login/logout/session mutation.
  // Then return getAuthenticatedUser(), or null after logout.
})
```

Authentication code must use this boundary **before** changing a session cookie,
and must not render quiz components itself. `reload()` re-resolves the provider
and can retry a failed startup. There is deliberately no final login UI here.

The transition synchronously unmounts the old React root, revokes storage reads
and subscriptions, drains pending local writes, cancels native replication,
aborts outstanding native HTTP requests, closes handles and clears memory. Only
then does the authentication callback execute. It opens the new UUID namespace
and mounts a fresh React root after hydration. Old in-memory sessions, question
banks, result screens and AI key state cannot be reused by the new tree.

Storage lifecycle operations are serialized and generation-checked. Superseded
initializations cannot become active. Old change-feed/status notifications cannot
notify new subscribers; refreshes already awaiting local IO are discarded. A
failed write flush keeps its queue and database for retry and **blocks the login
callback and next database open**. Logout never calls `destroy()`.

One hook required a small change: `src/hooks/useBusyAction.ts` now skips deferred
work after unmount. Its two-frame callback could otherwise run an old-account
save against the newly active store. `App.tsx`, all components, quiz/history hooks,
quiz/domain types, grading, import and result/review logic remain unchanged.

## localStorage inventory

| Key | Study behavior |
| --- | --- |
| `drillmcq.theme.v1` | Shared device appearance |
| `drillmcq_appearance.v1` | Shared device appearance |
| `drillmcq_sound.v1` | Shared device sound preference |
| `drillmcq_ai_prefs.v1:<uuid>` | Per-user AI configuration |
| `drillmcq_ai_key.v1:<uuid>` | Per-user API key, only on existing explicit remember opt-in |
| Unscoped AI prefs/key | Preserved; never adopted by a study user |
| `drillmcq_schema_version` | Legacy metadata; unchanged by study bootstrap |
| `drillmcq_saved_quizzes.v1`, `drillmcq_quiz_results.v1`, `drillmcq_active_session.v1`, `drillmcq.session.v1` | Legacy backups; neither read nor modified by study bootstrap |

`userScopedKey(baseKey, userId)` applies the same UUID validator. Signed-out or
transitioning storage returns default AI settings/no key and does not persist AI
writes. Preferences and secrets never enter replication. This is logical account
isolation, not encryption or protection from someone with access to browser
storage/devtools. Cached accounts remain on the device by design.

## Native gateway contract for the next iteration

Configure the build with:

```dotenv
VITE_LEARNING_SYNC_URL=/couchdb/my/
```

Blank disables remote sync. `VITE_COUCHDB_URL` is no longer consumed: replace it
and rebuild. Only the same-origin `/couchdb/my/` route is accepted (an absolute
same-origin URL or missing trailing slash is normalized). Concrete database
paths, credentials, query parameters, fragments and other origins are rejected
without preventing local startup or logging their values.

The browser still runs:

```ts
new PouchDB(remoteUrl, { skip_setup: true, /* request lifecycle options */ })
database.sync(remote, { live: true, retry: true })
```

The fetch option adds cancellation and an identity precondition; it does not
parse, manufacture or replace CouchDB protocol messages. Requests include
`X-Study-User: <canonical-local-user-uuid>` as an **expected identity precondition**.
The trusted gateway must:

1. Authenticate every `/couchdb/my/*` request using its session.
2. Resolve that session's internal, canonical UUID.
3. Require `X-Study-User` to equal the session UUID; reject a mismatch or missing
   header with 401/403, without reaching any CouchDB database. The header must
   never select the database or grant access. This prevents an old tab's local A
   store from syncing to B when another tab changes a shared session cookie.
4. Map **only the authenticated session UUID** to
   `semantic-drill-user-<UUID>`. Provision that database on the trusted side;
   `skip_setup` means the client does not create it.
5. Proxy the remaining native path/query/body/method and CouchDB response
   status/body/relevant headers unchanged. Preserve document IDs, revision tokens,
   checkpoints and long polling. Disable response caching and buffering that
   breaks `_changes`; use suitable long-poll timeouts.
6. Support the native database operations used by PouchDB, including `_changes`,
   `_all_docs`, `_bulk_docs`, `_revs_diff`, `_bulk_get` and `_local/*` checkpoint
   reads/writes. Do not implement a CRUD facade or emulate these endpoints.
7. Reject alternate database selectors and path escapes (including encoded ones),
   hide direct CouchDB/database/admin routes from the browser, and keep upstream
   credentials on the server. Use authenticated same-origin sessions and the
   corresponding CSRF/origin protections for mutations.

PouchDB 9 also probes `GET /couchdb/` for a server UUID when deriving replication
IDs. A gateway may return 404 there: the native adapter falls back to the logical
URL. Do not expose `_all_dbs`, server administration or arbitrary database access
just to satisfy this optional probe. The distinct local database IDs still keep
replication checkpoints separate between accounts.

Session expiration/revocation must fail closed. Never silently rebind an existing
server session to another UUID. A future login integration should notify other
tabs to suspend/reload when the identity changes; the required identity
precondition independently prevents cross-user remote replication in the interim.

## Validation and two-user pilot readiness

Run:

```sh
npm test
npm run lint
npm run build
```

Coverage includes two UUID databases, A → logout → B → A persistence, complete
quiz/progress/session/attempt round trips, untouched v1 data, user-specific AI
keys, invalid identities, overlapping transitions, failed-flush retry, delayed
change-feed refreshes, native live replication to a local PouchDB peer, HTTP
request cancellation/identity header, endpoint redaction, startup ordering,
logout, stale identity promises and deferred UI action cancellation.

Production pilot prerequisites still outside this change:

- An authenticated `/api/auth/me` implementation (or a replacement trusted provider).
- The above same-origin gateway with the identity precondition and two provisioned,
  isolated CouchDB databases, backed by suitable server access controls.
- A login/session-switch integration using `changeAccount`, or separately
  authenticated browser profiles; no OAuth/signup/reset/login UI is included.
- An end-to-end test against the actual HTTP gateway/CouchDB deployment, including
  attempts to select the other account's database and expired/mismatched sessions.

Automated replication tests use real PouchDB/IndexedDB with fake-indexeddb and a
local PouchDB peer. HTTP transport cancellation uses a controlled request stub;
it is not evidence of a deployed gateway. Browser UI smoke testing could not run
in this workspace because no browser was connected. The build reports Vite's
large-chunk advisory; it succeeds. No deployment was performed.

## Change inventory and final verification

Changed files:

```text
.env.example
README.md
docs/user-scoped-study.md
src/main.tsx
src/main.test.tsx
src/vite-env.d.ts
src/services/userIdentity.ts
src/services/userIdentity.test.ts
src/services/authentication.ts
src/services/authentication.test.ts
src/services/studyBootstrap.ts
src/services/learningDatabase.ts
src/services/storage.ts
src/services/storage.test.ts
src/services/userScopedStorage.test.ts
src/hooks/useBusyAction.ts
src/hooks/useBusyAction.test.ts
src/utils/library.test.ts
```

Final checks: `npm test` passed **458 tests in 19 files**; `npm run lint`,
`npm run build` and `git diff --check` passed. The build emitted the non-failing
large-chunk advisory noted above. No browser or live CouchDB gateway test was
possible in this environment.

`server-release` remains at `1b377d9422f1be1f0905080607bc8fb8875789d6` and
`server-collegues` remains at `7b58c9aca0d9c5b75ca5e916d9640af7b33397d8`.
The changes are on the new `server-collegues-study` branch, based on the former.
`App.tsx`, `src/components/`, all other hooks, domain types, quiz logic,
`package.json` and `package-lock.json` were intentionally left unchanged.

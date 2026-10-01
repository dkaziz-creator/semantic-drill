# Multi-user Semantic Drill (up to 50 users)

This server surrounds the existing DrillMQ application with login and per-user sync. It is intended for one small Node process and a private, single-node CouchDB 3.x instance. No signup, reset flow, quiz distribution, or changes to quiz scoring/data contracts are included.

## Runtime and persistence

Use Node **22.20 or newer** and `npm ci`. There are **no new runtime dependencies** and no web framework. `@types/node` is the only added development dependency. Node supplies HTTP streaming, crypto, cookies, static file serving, and the admin CLI. Separate `tsconfig.server.json` keeps server compilation out of the frontend build. `dist-server/` is ignored.

The private `semantic-drill-study-auth` database contains:

- `login:<normalized-login>`: `type: user`, canonical `userId` UUID, login, displayName, enabled, provisioned, mustChangePassword, password `{algorithm, salt, hash, cost}`, createdAt, CouchDB revision. Login is trimmed/lowercased ASCII, 3–64 characters, using letters, digits, `.`, `_`, and `-` (first character alphanumeric).
- `session:<sha256(token)>`: `type: session`, immutable userId, login lookup pointer, purpose (`change-password` or `study`), createdAt, expiresAt, CouchDB revision. The login pointer avoids an index; every request checks that its current user document still has the session's UUID and is enabled/provisioned. A session is never reassigned.

Passwords use asynchronous Node scrypt, **N=32768, r=8, p=1**, a random **32-byte salt**, and **64-byte derived hash**, encoded as hex. Verification honors stored parameters within bounded accepted ranges and uses `timingSafeEqual`. Unknown accounts and malformed stored hashes still run a dummy derivation. Passwords must have at least 12 characters and at most 1024 UTF-8 bytes. Login and password-change JSON are limited to 4096 bytes and a 10-second read deadline. At most four login/password-change hashing operations run at once; excess attempts receive 429. This protects a small server's CPU/memory; simultaneous sign-in bursts may need retrying.

Tokens are `randomBytes(32).toString('base64url')`; only their SHA-256 hashes are persisted. Sessions expire absolutely after **7 days**, configurable up to 30 days, without sliding renewal. Cookie: `study_session`, `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`, no Domain attribute. Production refuses insecure cookies or an HTTP public origin. Local HTTP requires **both** `NODE_ENV=development` and `SESSION_COOKIE_SECURE=false`. Logout revokes the session and clears the cookie; repeated logout is safe. Expired session documents can be removed later by trusted administration.

## Local setup

Install dependencies, copy `.env.example` to `.env.server`, and restrict access:

```bash
npm ci
cp .env.example .env.server
chmod 600 .env.server
```

Edit `.env.server` to contain these settings, replacing the credential placeholders. This file is ignored by git. Keep `VITE_DEV_USER_ID` blank during authentication testing.

```dotenv
NODE_ENV=development
STUDY_BIND_HOST=127.0.0.1
STUDY_PORT=3000
STUDY_PUBLIC_ORIGIN=http://localhost:3000
COUCHDB_INTERNAL_URL=http://127.0.0.1:5984
COUCHDB_USERNAME=replace-with-internal-couchdb-admin
COUCHDB_PASSWORD=replace-with-a-long-random-secret
SESSION_COOKIE_SECURE=false
SESSION_MAX_AGE_SECONDS=604800
```

`npm run server` and `npm run create-study-user` automatically read `.env.server`; existing process environment variables take precedence. Vite does **not** read that file. Only variables prefixed `VITE_` are eligible for the browser bundle; never use that prefix for server secrets. `STUDY_BIND_HOST` defaults to 127.0.0.1; `STUDY_PORT` defaults to 3000. Public origin and all three CouchDB settings are mandatory. CouchDB URL must be a plain HTTP(S) origin without embedded credentials, query, or path.

If CouchDB is not already available, one local Docker setup is:

```bash
read -r -p 'CouchDB admin name (same as .env.server): ' COUCHDB_USER
read -r -s -p 'CouchDB admin password (same as .env.server): ' COUCHDB_PASSWORD
printf '\n'
export COUCHDB_USER COUCHDB_PASSWORD
docker run -d --name semantic-drill-couch \
  -p 127.0.0.1:5984:5984 \
  --env COUCHDB_USER --env COUCHDB_PASSWORD \
  -v "$PWD/server/testing/couchdb.ini:/opt/couchdb/etc/local.d/study.ini:ro" \
  -v semantic-drill-couch-data:/opt/couchdb/data \
  couchdb:3.5.0
unset COUCHDB_USER COUCHDB_PASSWORD
```

The ini sets single-node mode, admin-only default database security, and authenticated direct access. Keep CouchDB's host port bound to loopback. Wait until CouchDB is ready before creating users. Protect the Docker daemon, host account, and environment file as trusted administration.

Create each of the 11 pilot users manually (two examples below). Each supplied password is temporary and must be replaced on first login. Bash `read -s` hides input; the secret travels through stdin, never an argument, committed file, or shell-history literal. Do not enable shell tracing (`set -x`) for these commands.

```bash
read -r -s -p 'Temporary password for david-test (12+ characters): ' study_password
printf '\n'
printf '%s' "$study_password" | npm run create-study-user -- \
  --login david-test --display-name David --password-stdin
unset study_password

read -r -s -p 'Temporary password for alex-test (12+ characters): ' study_password
printf '\n'
printf '%s' "$study_password" | npm run create-study-user -- \
  --login alex-test --display-name Alex --password-stdin
unset study_password
```

Record the UUID printed for each user. The CLI creates/secures the auth DB, creates a **disabled** user record with `mustChangePassword: true`, creates `semantic-drill-user-<UUID>`, applies `_security`, then enables the account. It logs each completed step. Existing logins cannot be silently overwritten. After interrupted provisioning, retry only the incomplete disabled record:

```bash
npm run create-study-user -- --login david-test --resume
```

Resume retains the original UUID, password hash, and first-login state; it never resets a password. It refuses an enabled or previously completed account. A CouchDB conflict is a safe failure, including two administrators racing to create the same login. No automatic cleanup drops partially created databases or records.

Build and start the same-origin application:

```bash
VITE_LEARNING_SYNC_URL=/couchdb/my/ npm run build
npm run server
```

Open **http://localhost:3000**. Sign in with the supplied temporary password, enter and confirm a different new password, then continue into the existing quiz application. Cancel signs out; signing in again with the temporary password resumes the required change until it succeeds. Startup checks that the authentication database exists and is reachable. It never auto-creates user databases. Sanitized startup errors contain no credential-bearing URL.

For hot-reload development, set `STUDY_PUBLIC_ORIGIN=http://localhost:5173` in `.env.server`, restart the backend, then run this in a second terminal:

```bash
VITE_LEARNING_SYNC_URL=/couchdb/my/ VITE_DEV_USER_ID= npm run dev -- --host localhost --port 5173 --strictPort
```

Vite forwards `/api/auth` and `/couchdb` to 127.0.0.1:3000. Keep browser and API on the configured public origin; do not open 3000 and 5173 interchangeably with the same cookie.

## Public API and exact routing

Authentication has three states: signed out, restricted `change-password` session, and normal `study` session.

```text
No session → login with valid credentials
  mustChangePassword=true             → change-password session → password-change screen
  mustChangePassword=false or missing → study session           → existing App

change-password session → valid different new password + revision-safe user write
  → mustChangePassword=false → revoke restricted token → fresh study token → existing App

Either session → logout → signed out
```

New users always have `mustChangePassword: true`. For backward compatibility, **missing user fields mean a permanent password**, so existing pilot users can sign in normally. Explicit false also means permanent; other malformed values fail closed during session resolution. Old session documents without an explicit purpose are rejected: users sign in again with their existing passwords after deployment. No bulk migration or password reset is required.

| Endpoint | Request / authorization | Successful response |
| --- | --- | --- |
| `POST /api/auth/login` | JSON `{login, password}`; verifies credentials before revealing state | `{status:"password_change_required"}` with a restricted cookie, or `{status:"authenticated", user:{id,displayName}}` with a study cookie |
| `GET /api/auth/state` | Session cookie, if present; no user identity or database metadata | `{authenticated:false}`, or `{authenticated:true, mustChangePassword:true/false}` |
| `GET /api/auth/me` | **Study session only** | `{id,displayName}` |
| `POST /api/auth/change-password` | **Change-password session only**; JSON `{password}` | `{status:"authenticated", user:{id,displayName}}` and a fresh study cookie |
| `POST /api/auth/logout` | Either session (also safe without a session) | `{ok:true}` and cleared cookie |

A restricted session cannot authorize `/me` or **any** `/couchdb/my/*` operation; these return 401 before contacting a learning database. It can inspect minimal auth state, change the password, or sign out. Normal study sessions cannot call the first-login password endpoint. Each resolver caller must specify the required purpose and checks expiration, enabled/provisioned state, UUID consistency, and current first-login state.

Password change uses the same 12-character/1024-UTF-8-byte policy and scrypt implementation as provisioning. One additional rule requires the new password to differ from the temporary password, so submitting the same secret cannot bypass the mandatory change. The endpoint accepts only bounded JSON bodies, applies the existing Origin/Fetch Metadata checks, and shares the login limiter and four-operation hashing limit. Invalid passwords return 400, invalid session/purpose 401, origin violations 403, revision conflicts 409, non-JSON input 415, oversized JSON 413, and excess attempts 429.

The user update includes the revision read during session validation. A conflict never retries by overwriting a newer account record: the client rechecks state and may explicitly retry. Once the password write succeeds, `mustChangePassword: false` invalidates **all** restricted sessions, including tokens left behind if session deletion or creation fails. Because CouchDB has no cross-document transaction here, a failure after that write returns a sanitized error and may require signing in with the **new** password. It never restores the temporary password or promotes the restricted token itself.

Invalid credentials use one generic 401 message, including unknown, disabled, incomplete, and wrong-password accounts. Existing session rotation still happens only after successful credential verification. Missing, expired, revoked, wrong-purpose, or disabled sessions return 401 on protected endpoints; `/state` reports `{authenticated:false}`. Auth responses are `Cache-Control: no-store`. Infrastructure failures are sanitized 503s. Responses never include password hashes, session tokens, database names, or CouchDB credentials.

Frontend startup reads `/state`; only a normal study state proceeds to `/me` and then opens local storage. A restricted state renders `StudyChangePassword` with new-password/confirmation fields and cancel/sign-out. Every login, password change, logout, and account switch uses `studyApplication.changeAccount()`: unmount, drain writes, close storage/replication, mutate the cookie, resolve access, then initialize the permitted user's storage. A refresh on the restricted screen preserves that state without opening any learning database. After completion the existing `App` renders unchanged.

Each `/couchdb/my/*` request independently:

1. Reads the HttpOnly cookie and hashes the token.
2. Reads that session from CouchDB, checks expiry and the `study` purpose, then resolves the enabled user's login record, permanent-password state, and immutable UUID.
3. Requires `X-Study-User` to exactly match the authenticated UUID. Missing/mismatched headers return 403 before any user database request; authentication metadata lookup is still needed.
4. Calls the shared `userDatabase(UUID)` helper. The header and browser URL **never select the database**.
5. Validates the **raw** target before URL normalization. Rejects dot segments, encoded traversal, double encoding, backslashes, absolute targets, and administration endpoints.
6. Streams the original method, query string, body and selected protocol headers to `/<derived-database>/<suffix>`, injecting server-side Basic authorization. Streams CouchDB status, bytes, ETag/revision and content headers back without rewriting JSON.

Allowed operations cover database info, documents/attachments, `_changes`, `_all_docs`, `_bulk_docs`, `_revs_diff`, `_bulk_get`, and `_local` checkpoints. Root PUT/DELETE, `_security`, `_design`, `_all_dbs`, `_users`, `_replication`, and server administration are not public routes. A database-looking document name is just a document inside the authenticated user's DB. Missing DBs return CouchDB's native 404; the gateway never provisions them. CouchDB cookies, authorization, CORS, redirects, and hop-by-hop headers are not relayed to browsers.

The proxy uses a dedicated keep-alive pool (up to 256 connections); metadata lookup has a separate pool and a 5-second timeout. Upstream connection establishment has a 5-second deadline. Once connected, gateway streams have **no short API/idle timeout**. Client disconnect aborts the corresponding upstream stream. Already-authorized streams remain authorized until disconnected; disabling an account or expiring a session blocks subsequent requests. The frontend cancels replication before login/logout/password change changes the cookie.

PouchDB 9 may probe `/couchdb/` for a server UUID. That route deliberately returns JSON 404; PouchDB falls back to the remote gateway URL for its replication ID. User-scoped local DB identities and per-user server checkpoint documents keep checkpoints separated.

## CouchDB security and deployment

For this small deployment, the CLI and backend use one **trusted internal CouchDB admin account**. Both authentication and per-user databases receive:

```json
{
  "admins": { "names": ["<internal-account>"], "roles": ["_admin"] },
  "members": { "names": ["<internal-account>"], "roles": ["_admin"] }
}
```

Other CouchDB administrators inherently retain access. No browser CouchDB accounts exist. `_security` restricts direct database access; request routing provides application user isolation. Keep CouchDB private even with these restrictions. CouchDB documents these permissions in its [security guide](https://docs.couchdb.org/en/stable/intro/security.html).

Production settings: `NODE_ENV=production`, `SESSION_COOKIE_SECURE=true`, and `STUDY_PUBLIC_ORIGIN=https://<actual-host>`; keep the Node bind address loopback when TLS terminates in a local reverse proxy/Funnel. Route the public origin to Node, **never to CouchDB**. Preserve Origin and cookies, disable proxy buffering for `/couchdb/my/`, allow long-poll durations, and do not cache authenticated routes. Do not add permissive CORS. Origin must exactly match the configured public origin when supplied; cross-site Fetch Metadata requests are rejected as well. Forwarded Host/Proto headers cannot override the configured origin.

Login rate limiting uses the socket address plus normalized login: 10 attempts/pair/5 minutes and 100 attempts/address/5 minutes. Success clears only the pair bucket. The map holds at most 4096 entries and removes stale buckets. Forwarded client addresses are deliberately not trusted: a Funnel/reverse proxy may share one IP bucket across all users. This is adequate for ordinary use by 50 people; a burst or repeated failures behind one proxy can require a five-minute retry. Limiter state resets on restart; users/sessions do not.

Back up CouchDB data and credentials. Do not expose this app and untrusted applications under the same origin. Learning data remains in each device's user-scoped IndexedDB after logout, as in the existing storage design; shared devices need separate OS/browser profiles. No new server-side encryption or retention policy is introduced.

## Automated verification

```bash
npm run typecheck:server
npm run test:server
npm test
npm run lint
VITE_LEARNING_SYNC_URL=/couchdb/my/ npm run build
npm run build:server
```

The server tests use a real loopback HTTP transport with a controlled CouchDB double, not a mocked gateway function. They exercise hashing, session storage/expiry/revocation, disabled users, CLI provisioning/resume, auth responses/cookies, Origin, rate limiting, raw paths, identity preconditions, response headers, native bodies and checkpoints. Concurrent tests hold A and B `_changes` responses open, receive initial streamed bytes, write a B quiz and A attempt, and read B's documents while both streams remain open; assertions inspect the exact upstream database and confirm the other user's documents cannot be read. A separate load test keeps **50 authenticated streams** open while each user writes and reads their own document. Upload streaming and client-disconnect cancellation are also asserted. Frontend tests check that old storage drains before login, password-change, and logout HTTP requests. First-login tests additionally cover restricted gateway denial, state-only startup, temporary-password replacement, session purposes, legacy accounts, concurrent revision conflicts, parallel changes, and recovery from session failures after a committed password update.

The normal server suite intentionally skips the real-CouchDB suite. To run it, start a **disposable** CouchDB, for example using the Docker command above with name `semantic-drill-couch-test`, host port **15984**, and a separate disposable data volume. Put its credentials in ignored `.env.couchdb-test`:

```dotenv
COUCHDB_TEST_URL=http://127.0.0.1:15984
COUCHDB_TEST_USERNAME=replace-with-disposable-couchdb-admin
COUCHDB_TEST_PASSWORD=replace-with-a-disposable-secret
```

```bash
chmod 600 .env.couchdb-test
npm run test:server:integration
```

This opt-in suite fails if configuration or CouchDB is unavailable. It provisions two random users, verifies both are restricted, completes their first-login password changes before granting access, overlaps long polls and writes, exercises `_bulk_docs`, `_revs_diff`, `_bulk_get`, documents, `_all_docs`, and checkpoint updates, verifies isolation and anonymous denial, runs the actual PouchDB client with independent local IndexedDBs and a second-device replica, then deletes only its test user databases and records. It leaves the private auth DB in place. Do not point it at production: provisioning sets auth DB security to the test account.

## Exact two-user/device acceptance procedure

1. Create `david-test` and `alex-test` with the CLI above and record their different UUIDs. Build with sync enabled. For two physical devices, deploy the HTTPS same-origin endpoint described above; loopback HTTP is only accessible on its host.
2. Insert the same valid saved quiz into both databases using a trusted local script. The following is deliberately a one-off administration command, not a sharing service. Replace the two UUID placeholders; it reads credentials from `.env.server` without putting them in command arguments:

   ```bash
   node --env-file=.env.server --input-type=module <<'JS'
   import { readFile } from 'node:fs/promises'
   import { loadConfig } from './dist-server/config.js'
   import { CouchClient } from './dist-server/couch/client.js'
   import { userDatabase } from './dist-server/auth/users.js'
   const couch = new CouchClient(loadConfig())
   const questions = JSON.parse(await readFile('src/data/sampleQuiz.json', 'utf8'))
   const now = Date.now()
   const document = {
     _id: 'quiz:pilot-shared', type: 'quiz', order: now,
     value: { id: 'pilot-shared', name: 'Pilot shared quiz', questions, createdAt: now }
   }
   for (const id of ['REPLACE_DAVID_UUID', 'REPLACE_ALEX_UUID']) {
     await couch.put(userDatabase(id), document._id, document)
     console.log(`Inserted pilot quiz for ${id}`)
   }
   JS
   ```

   Run once per fresh pair; conflicts safely refuse to overwrite existing quiz progress. If partially completed, rerun for only the missing user.

3. Open two independent browser profiles/devices simultaneously. Sign A in as David and B as Alex using their temporary passwords. Each must see the mandatory password-change screen. Refresh once and verify it persists; no learning storage or `/couchdb/my/` replication should open. Cancel/sign out once and sign back in to check recovery. Choose and confirm different new passwords; both must then see `Pilot shared quiz` after sync. Sign out and confirm the temporary passwords now fail and the new passwords work.
4. In DevTools → Application → IndexedDB, confirm separate `semantic-drill-learning-<UUID>` databases. In Network, confirm each browser sends its own `X-Study-User` and both maintain `_changes` requests to `/couchdb/my/` simultaneously.
5. David answers one question and leaves a quiz in progress. Alex's quiz must remain untouched. Alex answers a different question; David's progress must not change. Complete one attempt and verify history remains isolated. Keep both browsers active throughout.
6. Refresh both profiles: each must retain its own progress/history. Sign David out, then sign Alex in **in that profile**: Alex's data must load, with no David data. Sign David back in and verify his saved state returns.
7. Sign David in on a second device/profile. Wait for replication and confirm David's existing progress/history arrive. The two David sessions and Alex's session should coexist.
8. In David's authenticated browser, run the following with **Alex's UUID**; it must return 403. Omitting the identity header must also fail. Requests to `/couchdb/semantic-drill-user-<alex-uuid>/_all_docs`, `/couchdb/my/_security`, and `/couchdb/my/_all_dbs` must fail.

   ```js
   await fetch('/couchdb/my/_all_docs', {
     headers: { 'X-Study-User': 'REPLACE_ALEX_UUID' }
   }).then(r => r.status)
   ```

9. Confirm browser cookies are HttpOnly/Secure/SameSite=Strict in HTTPS deployment, logout clears its cookie, and no browser request contains the internal CouchDB password or Basic authorization. Port 5984 must be unreachable from the other device.

## 11-user pilot login procedure

Provision each of the 11 fixed accounts once using `--password-stdin` and a separate temporary password, and deliver each login/secret to its intended user through the agreed private channel. Give each user the HTTPS application URL. On first sign-in they must choose and confirm a different password before quizzes or sync become available. There is no signup or password-reset UI. Users keep their UUID and database throughout the change. Existing enabled pilot accounts without the new field keep their current passwords and only need to sign in again if their old session predates purpose tracking.

Use the two-user/device acceptance procedure above as the pilot gate, then repeat first login for the remaining accounts. Account provisioning, real CouchDB verification, HTTPS deployment, and browser/device acceptance still need an actual pilot environment; unit tests do not establish those deployment facts.

## First-login implementation handoff

Changed server files: `server/app.ts`, `server/auth/users.ts`, `server/auth/sessions.ts`, `server/couch/provisioning.ts`. Changed frontend files: `src/main.tsx`, `src/services/authentication.ts`, `src/services/studyBootstrap.ts`; added `src/components/StudyChangePassword.tsx`. Tests: added `server/tests/first-login.test.ts`; extended `server/tests/app.test.ts`, `server/tests/real-couch.test.ts`, `src/main.test.tsx`, and `src/services/authentication.test.ts`. Documentation: this file. No dependency or configuration changes.

Validation for this extension: **486 frontend tests passed; 65 server tests passed; 2 opt-in real-CouchDB tests skipped**. `npm run typecheck:server`, `npm run test:server`, `npm test`, `npm run lint`, `VITE_LEARNING_SYNC_URL=/couchdb/my/ npm run build`, `npm run build:server`, and `git diff --check` passed. Focused frontend auth tests also passed. The first server typecheck caught missing test mock `this` annotations; those were fixed and the typecheck rerun successfully. Vite retains its existing bundle-size advisory.

No disposable CouchDB service was listening on 5984/15984, and Docker, Podman, and CouchDB executables were unavailable. The extended real-CouchDB suite was not run. Browser/two-device acceptance and the actual 11-account deployment remain unverified.

## Original multi-user implementation handoff

Files added: `tsconfig.server.json`, `vitest.server.config.ts`, `server/config.ts`, `server/index.ts`, `server/app.ts`, `server/auth/{passwords,sessions,users,rateLimiter}.ts`, `server/couch/{client,gateway,provisioning}.ts`, `server/http/{cookies,security,static}.ts`, `server/scripts/create-user.ts`, `server/testing/couchdb.ini`, `server/tests/{helpers,security.test,app.test,real-couch.test}.ts`, `src/components/StudyLogin.tsx`, and this document.

Files changed: `.env.example`, `.gitignore`, `package.json`, `package-lock.json`, `eslint.config.js`, `vite.config.ts`, `src/main.tsx`, `src/main.test.tsx`, `src/services/authentication.ts`, `src/services/authentication.test.ts`, `src/services/studyBootstrap.ts`, `docs/user-scoped-study.md`, and `README.md`. `App.tsx`, quiz hooks/types/components, scoring, import, history and resume are unchanged.

Validation in the implementation environment: **461 frontend tests passed; 52 server tests passed; 2 real-CouchDB tests skipped**. Strict server typecheck, ESLint, frontend production build, server build, and `git diff --check` passed. The frontend build retains Vite's advisory about a bundle above 500 kB. HTTP smoke checks returned 200 for the app and JavaScript bundle and 401 for anonymous `/api/auth/me`. Browser automation was unavailable (no browser surfaces), so visual login/logout checks remain in the manual checklist.

The real CouchDB suite and manual two-device checklist require a running CouchDB and deployment. The implementation environment had neither CouchDB listening on 5984 nor Docker/Podman/Erlang installed, so those checks could not be executed there. A mock-transport pass is not claimed as real CouchDB evidence. Provision real users, run the opt-in suite, then complete the manual checklist before calling the physical two-device pilot verified.

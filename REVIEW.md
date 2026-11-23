# Canopy — Repository Audit (`REVIEW.md`)

**What this repo does:** Canopy is a browser app where people verify an account privately, pick hobbies, and join random 6-person rooms ("pods") for text chat, side threads, polls, voice notes, and live browser audio calls. Every room hides real names, emails, genders, and nationalities behind a fresh animal alias like `Cobalt Fox` and a room-only hash ID (`p_...`).

**Assumed load:** Hundreds of active users at once on one Spring Boot server (`:8090`), one Next.js frontend (`:3001`), and one MySQL 8.0 / PlanetScale Vitess database, matching the `ponytail:` single-node limits documented in the repo.

**Cross-slice & guardrail check:** All 20 REST endpoints, all 5 inbound and 14 outbound WebSocket (two-way live browser socket) message shapes, zero-PII room anonymity, zero Redux packages, zero violet colors in `frontend/src/`, and the `tasteskill` landing-page gate (`.taste-skill/build.done.json`, `0 FAIL`) match `PLAN.md` 1-for-1.

---

## Must fix

1. **Sign-in bounced back to `/login` after visiting `/app` logged out** (`frontend/src/app/login/page.tsx:L83-88`, `frontend/src/app/register/page.tsx:L130-135`, `frontend/src/app/app/page.tsx:L80-90`)
   - **What this is:** When a logged-out visitor clicks "Open the dashboard" on the home page, `/app` checks `/api/auth/me`, gets an unauthorized error, and sends them to `/login`.
   - **Problem:** Signing in or registering saved the new login token without clearing the cached error or bumping the auth counter, so `/app` saw the old error on mount and immediately sent the user back to `/login`. Signing into a second account within 30 seconds also showed the previous user's cached profile and rooms.
   - **Fix:** **[FIXED]** Cleared the query cache, reset the active room state, and incremented `authRevisionAtom` on login, register, and logout, and waited for any active auth refetch before redirecting (`npx tsc --noEmit` verified).
   - **If we skip it:** Visitors clicking the main home-page button fail to enter `/app` on their first login, and account switches in the same tab leak stale UI data.

2. **Any outside website could open a live room socket using the user's cookie** (`backend/src/main/kotlin/com/canopy/ws/WebSocketConfig.kt:L21-37`)
   - **What this is:** `/ws/pods/{podId}` opens a live WebSocket for chat and call setup, and accepts the browser's `canopy_jwt` login cookie when no token is in the URL.
   - **Problem:** The server allowed connections from `*` (every website) instead of checking `canopy.cors-origins`. A malicious page open in another tab could connect to a Canopy room using the signed-in user's cookie.
   - **Fix:** **[FIXED]** Restricted `.setAllowedOrigins(...)` to `canopy.cors-origins` (matching `SecurityConfig.java`) and added a test in `CanopyIntegrationTest` confirming `Origin: https://evil.example` is rejected.
   - **If we skip it:** Another site that knows or guesses a room ID can read live room messages and send call signals as the user.

3. **Private bookmarks leaked to other room members over live updates** (`backend/src/main/kotlin/com/canopy/chat/ChatDtos.kt:L85-93`)
   - **What this is:** Users can privately bookmark messages, while reactions, edits, pins, and poll votes broadcast the updated message to everyone in the room.
   - **Problem:** `personalizedForAlias` updated reaction and poll flags per viewer, leaving `isBookmarked` set to the actor's value. When a user who bookmarked a message pinned or reacted to it, every other member received `"isBookmarked": true` in their WebSocket frame.
   - **Fix:** **[FIXED]** Reset `isBookmarked = false` inside `personalizedForAlias` before broadcasting (clients preserve each viewer's own bookmark flag locally) and added an integration test check.
   - **If we skip it:** Peers can see which messages another member privately saved, and newly pinned messages appear bookmarked in other people's drawers.

4. **Reused user row numbers could expose a new user's private profile** (`backend/src/main/java/com/canopy/auth/AuthController.java:L151-162`)
   - **What this is:** A JSON Web Token (JWT, a signed 7-day login ticket) carries both the database row number (`uid`) and a unique 16-byte public ID (`sub`).
   - **Problem:** `/api/auth/me` and `PATCH /api/auth/me` looked up `users` only by `uid` without checking `public_id`. If the `users` table is reset or rebuilt so `id = 1` belongs to a new person, an old unexpired token for `uid = 1` reads and edits the new person's name, email, gender, and nationality.
   - **Fix:** **[FIXED]** Checked `Arrays.equals(user.publicId(), principal.userPublicId())` inside `AuthController.requireUser` and rejected mismatches with `401`.
   - **If we skip it:** Any database reset or ID reuse mixes up private account profiles.

5. **Loading room pins and short searches scanned every message in MySQL** (`db/migrations/001_init.sql:L101-105`, `backend/src/main/java/com/canopy/config/DatabaseInitializer.java:L119-123`)
   - **What this is:** A database index (a sorted lookup key) lets MySQL jump straight to one room's rows instead of reading the whole `messages` table.
   - **Problem:** `GET /api/pods/{podId}/pins` and `<3`-character searches filter by `pod_id`, while `messages` only indexed `(channel_id, is_pinned, id DESC)` and had no index starting with `pod_id`. Live `EXPLAIN` showed `possible_keys: NULL` and a backward scan across the entire `messages` table.
   - **Fix:** **[FIXED]** Added `KEY idx_messages_pod_pinned (pod_id, is_pinned, id DESC)` in `001_init.sql`, `DatabaseInitializer.java`, and online DDL (`ALGORITHM=INPLACE, LOCK=NONE`); `EXPLAIN` now shows `type: ref` on `idx_messages_pod_pinned` with zero sort pass on pins.
   - **If we skip it:** Opening the Pins drawer or searching `"gg"` gets slower with every message sent anywhere in Canopy.

6. **Null WebRTC signal crashed the browser call listener** (`frontend/src/state/voiceEngine.ts:L360-362`)
   - **What this is:** WebRTC (browser-to-browser audio) passes call offers and network addresses inside `frame.signal`.
   - **Problem:** `const { sdp, candidate } = frame.signal` ran outside the `try/catch` block even though the server allows `"signal": null`. A null `signal` threw an unhandled `TypeError` in the recipient's browser.
   - **Fix:** **[FIXED]** Guarded destructuring with `const { sdp, candidate } = frame.signal ?? {}`.
   - **If we skip it:** One malformed WebSocket frame triggers an unhandled promise error during a voice call.

---

## Should fix

7. **Matching into a room runs avoidable per-room SQL lookups** (`backend/src/main/kotlin/com/canopy/pods/BlindMatchService.kt:L188,L403,L555-565`)
   - **What this is:** After joining a room, `matchUserToPodByInterestId` loads the full room details to return from `POST /api/pods/match`.
   - **Problem:** `getPodDetailForUser` calls `listUserPods(principal)` and then runs `SELECT id FROM pods WHERE public_id = :pub` in a loop for every room the user belongs to, even though `outcome.podIdHex` is already in memory. `matchPods` then calls `listUserPods(principal)` again at the end.
   - **Fix:** Filter `listUserPods(principal)` by `p.podId == outcome.podIdHex` directly, and call `listUserPods` once in `matchPods`.
   - **If we skip it:** Matching 5 hobbies at once runs 10+ unnecessary database queries.

8. **Short JWT secrets are padded with zeros instead of rejected** (`backend/src/main/java/com/canopy/security/JwtService.java:L24-30`)
   - **What this is:** `JwtService` signs login tokens using `CANOPY_JWT_SECRET`.
   - **Problem:** If someone sets `CANOPY_JWT_SECRET` to a short string like `"prod"` in production, the constructor pads it to 32 bytes with zero bytes instead of refusing to start.
   - **Fix:** Throw `IllegalArgumentException("CANOPY_JWT_SECRET must be at least 32 bytes")` when `bytes.length < 32`.
   - **If we skip it:** A weak production secret looks healthy at boot while making login tokens easy to forge.

9. **Login cookie is missing the `Secure` flag on HTTPS** (`backend/src/main/java/com/canopy/auth/AuthController.java:L158-166`)
   - **What this is:** `writeAuthCookie` sets the `canopy_jwt` `HttpOnly` cookie on sign-in and registration.
   - **Problem:** It never calls `.secure(true)`, so browsers on a production HTTPS site will also attach the cookie to accidental plain HTTP requests.
   - **Fix:** Pass `request.isSecure()` (or a `canopy.cookie-secure` setting) into `.secure(...)` on `ResponseCookie`.
   - **If we skip it:** On networks without strict HTTPS-only headers, a plain HTTP link can expose the login cookie.

10. **Schema SQL is duplicated inside `DatabaseInitializer.java`** (`backend/src/main/java/com/canopy/config/DatabaseInitializer.java:L24-196`)
    - **What this is:** `DatabaseInitializer` reads `db/migrations/001_init.sql` when present and keeps a 172-line copy (`FALLBACK_DDL` and `FALLBACK_SEED`) in Java.
    - **Problem:** Any table or index update has to be edited in two files, or standalone JAR builds silently boot with an older schema.
    - **Fix:** Bundle `db/migrations/001_init.sql` and `db/seed.sql` into Maven classpath resources at build time and delete `FALLBACK_DDL` / `FALLBACK_SEED` (-172 lines).
    - **If we skip it:** Future SQL changes in `db/` can be missed when deploying a packaged JAR.

11. **Unused index `idx_messages_channel_pinned` and dead method `broadcastToPod`** (`db/migrations/001_init.sql:L103`, `backend/src/main/kotlin/com/canopy/ws/PodRealtimeHub.kt:L262-267`)
    - **What this is:** `idx_messages_channel_pinned` indexes pins per channel, and `broadcastToPod` sends raw maps to a room.
    - **Problem:** The app only queries pins per room (`idx_messages_pod_pinned`), so MySQL maintains `idx_messages_channel_pinned` on every message write without ever reading it. `broadcastToPod` has zero callers.
    - **Fix:** Drop `idx_messages_channel_pinned` when retiring channel-pin support, and delete `broadcastToPod` (-6 lines).
    - **If we skip it:** Every message write pays extra index maintenance, and dead unpersonalized broadcast code stays in the hub.

12. **Abandoned file uploads are never cleaned up** (`backend/src/main/java/com/canopy/media/AttachmentController.java:L118-134`)
    - **What this is:** Selecting a file uploads it to `backend/uploads/` with `message_id = 0` before the user sends the message.
    - **Problem:** If the user removes the file chip or closes the tab without sending, both the disk file and database row stay forever.
    - **Fix:** Run a daily task that deletes `message_attachments` rows and files where `message_id = 0` and `created_at` is older than 24 hours.
    - **If we skip it:** Cancelled uploads slowly consume disk space.

---

## Nice to have

13. **Secondary hero button has faint border contrast on the landing page** (`frontend/src/app/page.tsx:L395-397`, `.taste-skill/gate/consistency/report.json:L85-93`)
    - **What this is:** `tasteskill` passed with `0 FAIL`, and noted a `button-contrast` warning (`1.19:1`) on `"See how matching works"`.
    - **Problem:** Its light `#ebebeb` fill blends into the hero ground on bright screens.
    - **Fix:** Give `.hero .btn--secondary` a `1px solid rgba(35, 35, 35, 0.22)` outline and re-run `gate.mjs`.
    - **If we skip it:** The secondary link remains readable, though less distinct as a button.

14. **Sidebar status input lags behind `/status` chat command** (`frontend/src/state/wsPodClient.ts:L383-397`)
    - **What this is:** `presence_snapshot` updates live member statuses across open tabs.
    - **Problem:** It updates `p.members` in the `['pods']` cache without updating `p.myStatus`, so clearing status via `/status` in chat leaves the old text in the sidebar input until switching rooms.
    - **Fix:** Update `myStatus` from the matching `selfPeerId` member inside the `presence_snapshot` cache update.
    - **If we skip it:** The sidebar status box can briefly display outdated text.

---

**Verdict:** Healthy to ship for single-node v1 — all 6 Must-Fix defects (1–6) are fixed and verified (`mvn -B test` 6/6 passing, `npx tsc --noEmit` clean, `EXPLAIN` verified); address 7–9 before multi-user public launch.

**Lean:** -178 lines, -0 dependencies possible.

**Not checked:** Real TURN relay traversal across symmetric corporate NATs (currently configured with Google STUN only), multi-browser audio quality listening tests on physical microphones, and multi-shard VTGate live failover on a hosted PlanetScale cluster.

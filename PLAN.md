# Canopy — Shared Architecture & Exact API Contract (`PLAN.md`)

All agents MUST follow this exact contract so `db/`, `backend/` (Spring Boot 3.4 Java 21 + Kotlin 2.x), and `frontend/` (Next.js 15 + Jotai + TanStack + Tasteskill 2.5) integrate seamlessly.

## Runtime Ports & Credentials
- **MySQL 8.0 (`canopy-mysql` Docker container)**: `127.0.0.1:3308`
  - Dev JDBC URL: `jdbc:mysql://127.0.0.1:3308/canopy?useUnicode=true&characterEncoding=utf8&connectionCollation=utf8mb4_0900_ai_ci&allowMultiQueries=true&serverTimezone=UTC`
  - Test JDBC URL: `jdbc:mysql://127.0.0.1:3308/canopy_test?useUnicode=true&characterEncoding=utf8&connectionCollation=utf8mb4_0900_ai_ci&allowMultiQueries=true&serverTimezone=UTC`
  - User / Password: `canopy` / `canopy_dev_pw` (env overrides `DB_URL`, `DB_USER`, `DB_PASSWORD` for PlanetScale Vitess)
- **Spring Boot Backend (`backend/`)**: `http://localhost:8090` (`ws://localhost:8090`)
- **Next.js Frontend (`frontend/`)**: `http://localhost:3001` (`NEXT_PUBLIC_API_URL=http://localhost:8090`, `NEXT_PUBLIC_WS_URL=ws://localhost:8090`)

---

## Privacy & Authentication Boundary (CRITICAL)
1. **Private User Identity (`users` table)**:
   - Stores `email`, `password_hash` (BCrypt), `full_name`, `gender`, and `nationality_code` (`CHAR(2)`).
   - ONLY returned to the authenticated account owner via `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, and `PATCH /api/auth/me`.
2. **Peer-Blind Pods (`pods`, `pod_members`, `messages`, WebSocket)**:
   - Matching queries NEVER inspect `users.gender` or `users.nationality_code`.
   - Every `(pod_id, user_id)` gets a unique room-scoped alias (`Cobalt Fox`, `Amber Heron`, `Slate Otter`, `Mint Owl`, etc.) and deterministic room-scoped `peerId = UuidV7.peerId(podPublicIdBytes, userPublicIdBytes)` (`"p_" + 12 hex chars`).
   - NO pod/channel/message/reaction/poll/WebSocket payload ever exposes `userId`, `userPublicId`, `email`, `fullName`, `gender`, or `nationalityCode`.

---

## Shared Java <-> Kotlin Bridge Types (Pre-staged in `backend/src/main/java/com/canopy/`)
- `com.canopy.security.AuthPrincipal` (Java record stored in `SecurityContextHolder.getContext().getAuthentication().getPrincipal()` and WebSocket session attributes `"authPrincipal"`):
  - `long userId()`
  - `byte[] userPublicId()`
  - `String userPublicIdHex()`
  - `String email()`
- `com.canopy.util.UuidV7`:
  - `public static byte[] generate()` — 16-byte time-ordered UUIDv7
  - `public static String toHex(byte[] bytes)` — 32-char lowercase hex string
  - `public static byte[] fromHex(String hex)` — parses 32-char hex (or 36-char hyphenated UUID) to `byte[16]`
  - `public static String peerId(byte[] podPublicId, byte[] userPublicId)` — `"p_" + first 12 hex chars of SHA-256(podPublicId || userPublicId)`

---

## Exact Database DDL (`db/migrations/001_init.sql`)
Tables (all `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`):
- `users`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `public_id BINARY(16) UNIQUE`, `email VARCHAR(190) UNIQUE`, `password_hash VARCHAR(100)`, `full_name VARCHAR(100)`, `gender VARCHAR(32)`, `nationality_code CHAR(2)`, `created_at DATETIME`, `updated_at DATETIME`
- `interests`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `slug VARCHAR(64) UNIQUE`, `label VARCHAR(64)`, `category VARCHAR(32)`, `created_at DATETIME`
- `user_interests`: `(user_id, interest_id)` PK, `created_at DATETIME`, `KEY idx_user_interests_interest (interest_id, user_id)`
- `pods`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `public_id BINARY(16) UNIQUE`, `interest_id BIGINT UNSIGNED`, `code VARCHAR(32)`, `member_count TINYINT UNSIGNED DEFAULT 0`, `max_members TINYINT UNSIGNED DEFAULT 6`, `is_open TINYINT UNSIGNED DEFAULT 1`, `created_at DATETIME`, `KEY idx_pods_match (interest_id, is_open, member_count, id)`
- `pod_channels`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `public_id BINARY(16) UNIQUE`, `pod_id BIGINT UNSIGNED`, `slug VARCHAR(48)`, `label VARCHAR(64)`, `topic VARCHAR(160) DEFAULT ''`, `kind TINYINT UNSIGNED DEFAULT 1` (`1=TEXT`, `2=VOICE`), `position TINYINT UNSIGNED DEFAULT 0`, `created_at DATETIME`, `UNIQUE KEY idx_pod_channels_pod_slug (pod_id, slug)`, `KEY idx_pod_channels_pod_pos (pod_id, kind, position)`
- `pod_members`: `(pod_id, user_id)` PK, `alias VARCHAR(32)`, `alias_color VARCHAR(16)`, `custom_status VARCHAR(80) DEFAULT ''`, `voice_channel_id BIGINT UNSIGNED DEFAULT 0`, `joined_at DATETIME`, `KEY idx_pod_members_user (user_id, pod_id)`
- `pod_opt_outs`: `(user_id, pod_id)` PK, `left_at DATETIME`
- `messages`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `pod_id BIGINT UNSIGNED`, `channel_id BIGINT UNSIGNED`, `sender_user_id BIGINT UNSIGNED`, `sender_alias VARCHAR(32)`, `sender_color VARCHAR(16)`, `parent_message_id BIGINT UNSIGNED DEFAULT 0`, `quote_message_id BIGINT UNSIGNED DEFAULT 0`, `msg_type TINYINT UNSIGNED DEFAULT 1` (`1=TEXT`, `2=SYSTEM`, `3=POLL`, `4=VOICE_NOTE`, `5=ICEBREAKER`), `body VARCHAR(4000)`, `reply_count INT UNSIGNED DEFAULT 0`, `is_pinned TINYINT UNSIGNED DEFAULT 0`, `is_deleted TINYINT UNSIGNED DEFAULT 0`, `edited_at DATETIME NULL`, `created_at DATETIME`, `KEY idx_messages_channel_cursor (channel_id, parent_message_id, id DESC)`, `KEY idx_messages_thread_cursor (parent_message_id, id ASC)`, `KEY idx_messages_channel_pinned (channel_id, is_pinned, id DESC)`, `FULLTEXT KEY ft_messages_body (body)`
- `message_reactions`: `(message_id, emoji, user_id)` PK, `reactor_alias VARCHAR(32)`, `created_at DATETIME`
- `user_bookmarks`: `(user_id, message_id)` PK, `pod_id BIGINT UNSIGNED`, `created_at DATETIME`
- `message_attachments`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `message_id BIGINT UNSIGNED DEFAULT 0`, `pod_id BIGINT UNSIGNED`, `uploader_user_id BIGINT UNSIGNED`, `kind VARCHAR(16)` (`image`|`file`|`voice_note`), `file_name VARCHAR(180)`, `mime_type VARCHAR(80)`, `size_bytes INT UNSIGNED`, `duration_ms INT UNSIGNED DEFAULT 0`, `storage_path VARCHAR(255)`, `created_at DATETIME`, `KEY idx_attachments_message (message_id)`
- `polls`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `message_id BIGINT UNSIGNED UNIQUE`, `question VARCHAR(240)`, `options_json JSON`, `is_closed TINYINT UNSIGNED DEFAULT 0`, `created_at DATETIME`
- `poll_votes`: `(poll_id, user_id)` PK, `option_index TINYINT UNSIGNED`, `voter_alias VARCHAR(32)`, `created_at DATETIME`

---

## Exact REST API Contract (`camelCase` JSON)

Auth token accepted via EITHER `Authorization: Bearer <token>` header OR `canopy_jwt` `HttpOnly` cookie (Bearer header takes precedence when present so multi-tab independent accounts via `sessionStorage` work cleanly!).

### Auth & Private Profile (`Java 21` — `com.canopy.auth` & `com.canopy.media`)
- `POST /api/auth/register`
  - Req: `{ "email": "...", "password": "...", "fullName": "...", "gender": "...", "nationalityCode": "IN" }`
  - Res `201`: `{ "token": "<jwt>", "user": { "userId": "<hex>", "email": "...", "fullName": "...", "gender": "...", "nationalityCode": "IN" } }` (also sets `canopy_jwt` cookie unless `?tabOnly=true`)
- `POST /api/auth/login`
  - Req: `{ "email": "...", "password": "..." }`
  - Res `200`: `{ "token": "<jwt>", "user": { ... } }`
- `POST /api/auth/logout` -> clears cookie, `200 { "ok": true }`
- `GET /api/auth/me` -> `200 { "user": { "userId": "...", "email": "...", "fullName": "...", "gender": "...", "nationalityCode": "..." } }`
- `PATCH /api/auth/me` -> Req `{ "fullName": "...", "gender": "...", "nationalityCode": "..." }` -> `200 { "user": { ... } }`
- `POST /api/pods/{podId}/attachments` (`multipart/form-data`: `file`, `kind`=`image|file|voice_note`, `durationMs`=`0`)
  - Verifies caller is in `podId`, saves file in `backend/uploads/`, inserts `message_attachments` with `message_id = 0`, returns `201`:
    `{ "id": 42, "kind": "voice_note", "fileName": "voice.webm", "mimeType": "audio/webm", "sizeBytes": 18240, "durationMs": 4200, "url": "/api/attachments/42" }`
- `GET /api/attachments/{attachmentId}` -> Verifies caller is in the attachment's `pod_id` (via cookie or `?token=` query param for `<audio src>` / `<img src>`!), streams bytes with `Content-Type`.

### Blind Pods, Matching & Channels (`Kotlin 2.x` — `com.canopy.pods`)
- `GET /api/interests`
  - Res: `{ "interests": [{ "slug": "gaming", "label": "Gaming", "category": "play", "openPods": 1, "activeMembers": 4, "selected": true }] }`
- `PUT /api/me/interests`
  - Req: `{ "interests": ["gaming", "chess", "Custom Hobby"] }` -> creates new normalized slug if custom, replaces `user_interests`, returns `{ "interests": [...] }`
- `POST /api/pods/match`
  - Req: `{ "interest": "gaming", "matchAll": false, "maxMembers": null | 4 | 6 | 10, "forceNewPod": false, "allowAdditional": false }`
    - `maxMembers`: optional pod capacity preset (`4` = Cozy, `6` = Squad default, `10` = Lounge; `null` matches any open size and defaults to `6` on creation).
    - `forceNewPod`: when `true`, skips candidate open pods and creates a brand-new pod with `maxMembers ?: 6` (also implies `allowAdditional`).
    - `allowAdditional`: when `true`, allows joining another open pod (excluding pods the user is already in and `pod_opt_outs`) or creating one even if the user is already in 1+ pods for that interest (up to 8 active pods per interest per user).
    - If `matchAll: true`, matches all `user_interests` where user is not already in a pod, using `maxMembers` / `forceNewPod` if specified.
  - Res: `{ "matched": [ PodDetailDto ], "pods": [ PodDetailDto ] }`
- `GET /api/pods`
  - Res: `{ "pods": [ PodDetailDto ] }`
  - `PodDetailDto` shape:
    ```json
    {
      "podId": "0193...",
      "code": "gaming-4821",
      "interestSlug": "gaming",
      "interestLabel": "Gaming",
      "myPeerId": "p_9f81a204bc11",
      "myAlias": "Cobalt Fox",
      "myColor": "#1f6b3a",
      "myStatus": "",
      "memberCount": 3,
      "maxMembers": 6,
      "channels": [
        { "channelId": "0193...", "slug": "general", "label": "general", "topic": "Main group chat", "kind": "TEXT", "position": 0 },
        { "channelId": "0193...", "slug": "lounge-voice", "label": "Lounge Voice", "topic": "Drop-in voice", "kind": "VOICE", "position": 3 }
      ],
      "members": [
        { "peerId": "p_9f81a204bc11", "alias": "Cobalt Fox", "color": "#1f6b3a", "customStatus": "", "online": true, "voiceChannelId": null, "isSelf": true }
      ]
    }
    ```
- `POST /api/pods/{podId}/channels`
  - Req: `{ "label": "builds-and-clips", "topic": "Share setups", "kind": "TEXT" }` (`TEXT` or `VOICE`) -> broadcasts `channel_created`, returns `{ "channel": ChannelDto }`
- `PATCH /api/pods/{podId}/status`
  - Req: `{ "customStatus": "Ready for co-op" }` -> broadcasts `presence_snapshot`, returns `{ "ok": true }`
- `POST /api/pods/{podId}/leave`
  - Req: `{ "rematch": false, "maxMembers": null | 4 | 6 | 10, "forceNewPod": false }` -> removes member, records `pod_opt_outs`, closes any active voice/WS state, broadcasts `member_left`. If `rematch: true`, immediately assigns another random pod for the same interest (skipping all `pod_opt_outs` and any pods the user is already a member of, honoring optional `maxMembers` and `forceNewPod`!) and returns `{ "leftPodId": "...", "newPod": PodDetailDto | null }`.
- `POST /api/pods/{podId}/invites` (Authenticated pod member)
  - Req (optional): `{ "maxUses": 0, "expiresInHours": 168, "regenerate": false }` (`maxUses`: `0` = unlimited while seats open, or `1..100`; `expiresInHours`: `0` = never, default `168` = 7 days).
  - Res `200`/`201`: `{ "invite": PodInviteDto }` where `PodInviteDto` = `{ "code": "m8k4p2x9q7w3", "podId": "...", "podCode": "gaming-5294", "interestSlug": "gaming", "interestLabel": "Gaming", "invitedByAlias": "Mint Ibis", "memberCount": 2, "maxMembers": 4, "maxUses": 0, "usesCount": 0, "expiresAt": "2026-11-30T15:30:00Z" | null, "createdAt": "...", "isExpired": false, "isRevoked": false, "isFull": false, "canAccept": true }`.
- `GET /api/pods/{podId}/invites` (Authenticated pod member) -> `{ "invites": [ PodInviteDto ] }`
- `DELETE /api/pods/{podId}/invites/{code}` (Authenticated pod member) -> revokes invite (`is_revoked = 1`), returns `{ "ok": true }`
- `GET /api/invites/{code}` (**PUBLIC — permitted without auth, strictly zero PII!**) -> `{ "invite": PodInviteDto }` (`404` if unknown)
- `POST /api/invites/{code}/accept` (Authenticated user) -> joins pod via invite code (idempotent if already member; clears prior `pod_opt_outs` for that pod; rejects with `410` if revoked/expired/maxUses reached or `409` if pod full), broadcasts `member_joined` + system message, returns `{ "alreadyMember": false, "pod": PodDetailDto, "pods": [ PodDetailDto ] }`.

### Slack + Discord Rich Chat, Threads, Polls, Pins, Bookmarks & Search (`Kotlin 2.x` — `com.canopy.chat`)
- `GET /api/pods/{podId}/channels/{channelId}/messages?beforeId=0&limit=40`
  - Returns top-level channel messages (`parent_message_id = 0`) chronologically (`oldest -> newest` of fetched page) + `"nextBeforeId": 0 | number`:
    ```json
    {
      "messages": [ RichMessageDto ],
      "nextBeforeId": 0
    }
    ```
  - `RichMessageDto` shape:
    ```json
    {
      "id": 105,
      "podId": "0193...",
      "channelId": "0193...",
      "senderPeerId": "p_9f81a204bc11",
      "senderAlias": "Cobalt Fox",
      "senderColor": "#1f6b3a",
      "parentMessageId": 0,
      "quoteMessage": null,
      "msgType": "TEXT",
      "body": "Anyone up for **co-op** tonight? ||No spoilers||",
      "replyCount": 2,
      "isPinned": false,
      "isBookmarked": false,
      "isDeleted": false,
      "editedAt": null,
      "createdAt": "2026-11-20T15:45:00Z",
      "reactions": [
        { "emoji": "🔥", "count": 2, "aliases": ["Cobalt Fox", "Amber Heron"], "meReacted": true }
      ],
      "attachments": [],
      "poll": null
    }
    ```
  - When `msgType == "POLL"`, `"poll"` is:
    `{ "pollId": 12, "question": "What game tonight?", "isClosed": false, "options": [{ "index": 0, "label": "Helldivers", "votes": 2, "voters": ["Cobalt Fox", "Amber Heron"], "meVoted": true }] }`
- `GET /api/pods/{podId}/channels/{channelId}/threads/{parentMessageId}`
  - Res: `{ "parent": RichMessageDto, "replies": [ RichMessageDto ] }`
- `POST /api/pods/{podId}/channels/{channelId}/messages`
  - Req: `{ "body": "...", "parentMessageId": 0, "quoteMessageId": 0, "attachmentIds": [] }`
  - Slash commands handled automatically if `body` starts with:
    - `/poll "Question?" "Option 1" "Option 2" ...` (or pipe-separated `/poll Question? | Opt 1 | Opt 2`) -> creates `msgType = "POLL"` + `polls` row!
    - `/icebreaker` -> creates `msgType = "ICEBREAKER"` with a curated question for the pod's interest!
    - `/shrug <text>` -> appends ` ¯\_(ツ)_/¯`
    - `/status <text>` -> updates `custom_status` in `pod_members` and returns `{ "commandHandled": "status" }` or posts nothing/updates presence!
  - Broadcasts `message_created` (or `thread_reply_created` + updated parent `message_updated` when `parentMessageId > 0`) to pod WebSocket!
  - Res `201`: `{ "message": RichMessageDto }`
- `PATCH /api/messages/{messageId}` -> Req `{ "body": "..." }` -> broadcasts `message_updated`, returns `{ "message": RichMessageDto }`
- `DELETE /api/messages/{messageId}` -> soft-deletes (`is_deleted = 1, body = ''`), broadcasts `message_deleted`, returns `{ "ok": true }`
- `POST /api/messages/{messageId}/reactions` -> Req `{ "emoji": "🔥" }` -> toggles reaction for caller, broadcasts `reaction_updated`, returns `{ "message": RichMessageDto }`
- `POST /api/messages/{messageId}/pin` -> toggles `is_pinned`, broadcasts `pin_updated`, returns `{ "message": RichMessageDto }`
- `POST /api/messages/{messageId}/bookmark` -> toggles row in `user_bookmarks`, returns `{ "bookmarked": true, "message": RichMessageDto }`
- `POST /api/polls/{pollId}/vote` -> Req `{ "optionIndex": 0 }` -> upserts vote in `poll_votes`, broadcasts `poll_updated`, returns `{ "message": RichMessageDto }`
- `GET /api/pods/{podId}/pins` -> Res `{ "messages": [ RichMessageDto ] }`
- `GET /api/bookmarks` -> Res `{ "messages": [ RichMessageDto ] }`
- `GET /api/pods/{podId}/search?q=...` -> Uses MySQL `FULLTEXT` (`MATCH(m.body) AGAINST(:booleanQuery IN BOOLEAN MODE)` with fallback `LIKE` for <3 char tokens), returns `{ "messages": [ RichMessageDto ] }`

---

## Phase 4 Contract: 25-Member Pods, Democratic Governance Voting & Premium Admin Groups

### 1. User Plan Tier (`Java 21` — `com.canopy.auth`)
- `SelfUser` (`/api/auth/register`, `/api/auth/login`, `/api/auth/me`, `/api/auth/plan`) now includes `"planTier": "FREE" | "PREMIUM"`.
- `POST /api/auth/plan`: Req `{ "planTier": "PREMIUM" | "FREE" }` -> updates `users.plan_tier`, returns `{ "user": SelfUser }`.

### 2. 25-Member Default Pods & Extended Pod / Member DTOs (`Kotlin 2.x` — `com.canopy.pods`)
- Default `maxMembers` for matched pods is now **`25`**! Allowed capacity presets: `10` (`Compact`), `25` (`Standard`, default when `maxMembers == null`), `50` (`Club`) (backend also accepts `4` and `6` for backward compatibility).
- Random blind matching (`POST /api/pods/match`) ONLY matches into open pods where `allow_random_match = 1` (`DEMOCRATIC` community pods).
- `PodDetailDto` fields:
  ```json
  {
    "podId": "0193...",
    "code": "gaming-4821",
    "title": "",
    "description": "",
    "interestSlug": "gaming",
    "interestLabel": "Gaming",
    "governanceMode": "DEMOCRATIC",
    "isPublicized": false,
    "allowRandomMatch": true,
    "myPeerId": "p_...",
    "myAlias": "Cobalt Fox",
    "myColor": "#1f6b3a",
    "myRole": "MEMBER",
    "myStatus": "",
    "memberCount": 5,
    "maxMembers": 25,
    "openProposalsCount": 1,
    "channels": [ ChannelDto ],
    "members": [
      { "peerId": "p_...", "alias": "Cobalt Fox", "color": "#1f6b3a", "role": "MEMBER", "customStatus": "", "online": true, "voiceChannelId": null, "isSelf": true }
    ]
  }
  ```

### 3. Democratic Pod Governance (`governanceMode == "DEMOCRATIC"` — Every Pod Action Uses YES vs NO Voting)
- In a `DEMOCRATIC` pod, no single member has admin rights. Every pod-level mutation (`KICK_MEMBER`, `ADD_CHANNEL`, `REMOVE_CHANNEL`, `RENAME_POD`, `UPDATE_TOPIC`, `CHANGE_CAPACITY`, `TOGGLE_LOCK`, `PIN_MESSAGE`) goes through a **Pod Proposal Vote** (`YES` vs `NO`):
  - Note: If someone calls `POST /api/pods/{podId}/channels` or `POST /api/messages/{messageId}/pin` on a `DEMOCRATIC` pod when `memberCount > 1`, either auto-create the corresponding proposal OR return `409`/`202` — cleanest: have `POST /api/pods/{podId}/proposals` be the unified democratic action endpoint (and if `POST /api/pods/{podId}/channels` is called on a `DEMOCRATIC` pod with `memberCount == 1`, it succeeds; with `memberCount > 1`, throw `403` `"Democratic pods require a member vote to add channels — submit a proposal"` so UI uses proposals cleanly!). Same for `PIN_MESSAGE` (`POST /api/messages/{id}/pin`: immediate in `ADMIN` pod for `OWNER`/`ADMIN` or 1-member democratic pod; in multi-member `DEMOCRATIC` pod, creates/requires a `PIN_MESSAGE` proposal!).
- `POST /api/pods/{podId}/proposals`:
  - Req:
    ```json
    {
      "kind": "KICK_MEMBER" | "ADD_CHANNEL" | "REMOVE_CHANNEL" | "RENAME_POD" | "UPDATE_TOPIC" | "CHANGE_CAPACITY" | "TOGGLE_LOCK" | "PIN_MESSAGE",
      "targetPeerId": "p_...",
      "channelId": "0193...",
      "label": "builds-and-clips",
      "topic": "Share setups",
      "channelKind": "TEXT",
      "maxMembers": 25,
      "locked": false,
      "messageId": 105,
      "reason": "Disruptive audio spam",
      "expiresInMinutes": 5
    }
    ```
  - Automatically records Proposer's `YES` vote (`vote = 1`), posts a `msgType = "GOVERNANCE"` message (`msg_type = 6`) in `#general` linked via `announcement_message_id`, evaluates resolution immediately (`eligibleCount` = current `pod.memberCount`; `remaining = max(0, eligibleCount - yesCount - noCount)`; if `yesCount > noCount + remaining` -> **PASSES & EXECUTES IMMEDIATELY**; else if `yesCount + remaining <= noCount` -> **REJECTS IMMEDIATELY**), broadcasts `proposal_updated` (+ `pod_updated` / `channel_created` / `channel_deleted` / `member_kicked` if executed), and returns `{ "proposal": PodProposalDto, "pod": PodDetailDto }`.
- `POST /api/proposals/{proposalId}/vote`:
  - Req: `{ "vote": true | false }` (`true = YES`, `false = NO`).
  - Upserts caller's vote in `pod_proposal_votes`, re-evaluates resolution (`yesCount > noCount + remaining` -> execute & pass; `yesCount + remaining <= noCount` -> reject; if `now >= expiresAt` -> `yesCount > noCount` execute & pass else reject), broadcasts `proposal_updated` (and updated `GOVERNANCE` chat message `message_updated`!), returns `{ "proposal": PodProposalDto, "pod": PodDetailDto | null }`.
- `POST /api/proposals/{proposalId}/resolve`:
  - Allows finalizing an expired proposal on demand (in addition to a `@Scheduled(fixedDelay = 5000)` sweep in Spring Boot that automatically resolves any `OPEN` proposals whose `expires_at <= UTC_TIMESTAMP()` using **`yesCount > noCount`**!).
- `GET /api/pods/{podId}/proposals`:
  - Res: `{ "proposals": [ PodProposalDto ] }` where `PodProposalDto` = `{ "id": 7, "podId": "...", "kind": "KICK_MEMBER", "title": "Kick Slate Otter from pod", "reason": "...", "proposerAlias": "Cobalt Fox", "targetPeerId": "p_...", "targetAlias": "Slate Otter", "status": "OPEN" | "PASSED" | "REJECTED", "yesCount": 3, "noCount": 1, "eligibleCount": 5, "yesAliases": ["Cobalt Fox", ...], "noAliases": ["..."], "myVote": true | false | null, "expiresAt": "...", "resolvedAt": null, "createdAt": "..." }`.
- `RichMessageDto` adds optional `"proposal": PodProposalDto | null` when `msgType == "GOVERNANCE"`.

### 4. Premium Custom Admin Pods & Publicized Groups Directory (`governanceMode == "ADMIN"`)
- `POST /api/pods/custom` (Requires `users.plan_tier == 'PREMIUM'`, else `403` `"Canopy Pro plan required to create custom admin groups"`):
  - Req: `{ "title": "Tactical Co-op Raiders", "code": "tactical-raiders", "interest": "gaming", "description": "Nightly Helldivers runs", "maxMembers": 25, "isPublicized": true }`
  - Creates pod with `governance_mode = 'ADMIN'`, `owner_user_id = userId`, `is_publicized = 1|0`, `allow_random_match = 0`, assigns creator `role = 'OWNER'`, creates 5 default channels, returns `201 { "pod": PodDetailDto, "pods": [ PodDetailDto ] }`.
- `GET /api/pods/publicized?interest=`:
  - Returns `{ "groups": [{ "podId": "...", "code": "tactical-raiders", "title": "Tactical Co-op Raiders", "description": "...", "interestSlug": "gaming", "interestLabel": "Gaming", "founderAlias": "Cobalt Fox", "memberCount": 4, "maxMembers": 25, "alreadyMember": false }] }` (strictly zero PII!).
- `POST /api/pods/{podId}/join`:
  - Joins a `PUBLICIZED` (`is_publicized = 1`) group directly (`403` if private or previously kicked in `pod_opt_outs`, `409` if full), returns `{ "pod": PodDetailDto, "pods": [ PodDetailDto ] }`.
- **Instant Admin Endpoints (`ADMIN` pods only, caller must have `role IN ('OWNER', 'ADMIN')`)**:
  - `PATCH /api/pods/{podId}/settings`: Req `{ "title": "...", "description": "...", "maxMembers": 25, "isPublicized": true, "isOpen": true }` -> returns `{ "pod": PodDetailDto }`, broadcasts `pod_updated`.
  - `POST /api/pods/{podId}/admin/kick`: Req `{ "targetPeerId": "p_..." }` (cannot kick `OWNER`) -> removes member immediately, inserts `pod_opt_outs`, evicts WS/voice, broadcasts `member_kicked` + `member_left`, returns `{ "pod": PodDetailDto }`.
  - `POST /api/pods/{podId}/admin/role`: Req `{ "targetPeerId": "p_...", "role": "ADMIN" | "MEMBER" }` (`OWNER` only) -> updates `pod_members.role`, broadcasts `pod_updated`, returns `{ "pod": PodDetailDto }`.
  - `DELETE /api/pods/{podId}/channels/{channelId}`: Deletes channel immediately (protecting `#general`), broadcasts `channel_deleted`, returns `{ "pod": PodDetailDto }`.

### Additional WebSocket Outbound Frames:
- `{ "type": "proposal_updated", "proposal": PodProposalDto }`
- `{ "type": "pod_updated", "pod": PodDetailDto }` (personalized per connected session!)
- `{ "type": "channel_deleted", "channelId": "0193..." }`
- `{ "type": "member_kicked", "peerId": "p_...", "alias": "Slate Otter" }`

---

## Exact Native WebSocket Contract (`/ws/pods/{podId}?token=<jwt>`)

### Client -> Server JSON frames (`"type"`):
- `{ "type": "typing", "channelId": "0193...", "isTyping": true }`
- `{ "type": "voice_join", "voiceChannelId": "0193...", "muted": false, "deafened": false }`
- `{ "type": "voice_leave" }`
- `{ "type": "voice_state", "muted": false, "deafened": false, "speaking": true }`
- `{ "type": "webrtc_signal", "targetPeerId": "p_...", "voiceChannelId": "0193...", "signal": { ... } }`

### Server -> Client JSON frames (`"type"`):
- `{ "type": "presence_snapshot", "podId": "0193...", "selfPeerId": "p_...", "onlinePeerIds": ["p_..."], "members": [ MemberDto ], "voiceRoster": { "<voiceChannelId>": [{ "peerId": "p_...", "alias": "Cobalt Fox", "color": "#1f6b3a", "muted": false, "deafened": false, "speaking": false }] } }`
- `{ "type": "typing_update", "channelId": "0193...", "typingAliases": ["Cobalt Fox"] }`
- `{ "type": "message_created", "channelId": "0193...", "message": RichMessageDto }`
- `{ "type": "thread_reply_created", "channelId": "0193...", "parentMessageId": 105, "reply": RichMessageDto, "parentReplyCount": 3 }`
- `{ "type": "message_updated", "channelId": "0193...", "message": RichMessageDto }`
- `{ "type": "message_deleted", "channelId": "0193...", "messageId": 105, "parentMessageId": 0 }`
- `{ "type": "reaction_updated", "channelId": "0193...", "message": RichMessageDto }`
- `{ "type": "pin_updated", "channelId": "0193...", "message": RichMessageDto }`
- `{ "type": "poll_updated", "channelId": "0193...", "message": RichMessageDto }`
- `{ "type": "channel_created", "channel": ChannelDto }`
- `{ "type": "member_joined", "member": MemberDto }`
- `{ "type": "member_left", "peerId": "p_...", "alias": "Cobalt Fox" }`
- `{ "type": "voice_roster_updated", "voiceRoster": { "<voiceChannelId>": [ VoicePeerDto ] } }`
- `{ "type": "webrtc_signal", "voiceChannelId": "0193...", "fromPeerId": "p_...", "fromAlias": "Cobalt Fox", "signal": { ... } }`

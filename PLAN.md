# Canopy — Shared Architecture & Exact API Contract (`PLAN.md`)

All agents MUST follow this exact contract so `db/`, `backend/` (Spring Boot 3.4 Java 21 + Kotlin 2.x), `frontend/` (Next.js 15 + Jotai + TanStack + Tasteskill 2.5), and `mobile/` (React Native + Expo SDK 52) integrate seamlessly.

## Product Ergonomic: Pure Chat Feel (Zero Channels, 1 Pod Group Chat + 1:1 Member Private Messages)
- **NO Slack-style `#channels` (`pod_channels` removed) and NO Slack side-thread drawers (`parent_message_id` / `threads` removed)!**
- Every **Pod** (`10` Compact / `25` Standard default / `50` Club) has a clean, modern **Chat / Messenger feel**:
  1. **1 Pod Group Chat** (`recipientPeerId == null`): Shared room stream for all pod members with inline quoted replies (`quoteMessage`), emoji reactions, attachments, voice notes, `/poll`, `/icebreaker`, Democratic `YES > NO` Pod Votes, pins, bookmarks, search, and **1 Pod Group Audio Call** (`voicePeers`).
  2. **1:1 Private Messages (DMs) with Any Pod Member** (`recipientPeerId == "p_..."`): Click/tap any peer-blind pod member (`Cobalt Fox`, `Jade Owl`, etc.) to chat privately 1-on-1 inside that pod! Strictly private — REST, WebSocket frames, typing indicators, search, and attachments for a 1:1 DM are accessible **ONLY** to the two participating members of that DM, while preserving 100% peer-blind anonymity (zero real names, emails, genders, nationalities, or raw `user_id`s ever exposed).

## Runtime Ports & Credentials
- **MySQL 8.0 (`127.0.0.1:3308`)**:
  - Dev JDBC URL: `jdbc:mysql://127.0.0.1:3308/canopy?useUnicode=true&characterEncoding=utf8&connectionCollation=utf8mb4_0900_ai_ci&allowMultiQueries=true&serverTimezone=UTC`
  - Test JDBC URL: `jdbc:mysql://127.0.0.1:3308/canopy_test?useUnicode=true&characterEncoding=utf8&connectionCollation=utf8mb4_0900_ai_ci&allowMultiQueries=true&serverTimezone=UTC`
  - User / Password: `canopy` / `canopy_dev_pw` (env overrides `DB_URL`, `DB_USER`, `DB_PASSWORD` for PlanetScale Vitess)
- **Spring Boot Backend (`backend/`)**: `http://localhost:8090` (`ws://localhost:8090`)
- **Next.js Frontend (`frontend/`)**: `http://localhost:3001` or `:3002` (`NEXT_PUBLIC_API_URL=http://localhost:8090`, `NEXT_PUBLIC_WS_URL=ws://localhost:8090`)

---

## Privacy & Authentication Boundary (CRITICAL)
1. **Private User Identity (`users` table)**:
   - Stores `email`, `password_hash` (BCrypt), `full_name`, `gender`, `nationality_code` (`CHAR(2)`), and `plan_tier` (`FREE` | `PREMIUM`).
   - ONLY returned to the authenticated account owner via `/api/auth/**`.
2. **Peer-Blind Pods (`pods`, `pod_members`, `messages`, WebSocket)**:
   - Matching queries NEVER inspect `users.gender` or `users.nationality_code`.
   - Every `(pod_id, user_id)` gets an unlinkable room-scoped alias (`Cobalt Fox`, `Jade Owl`, etc.) and deterministic room-scoped `peerId = UuidV7.peerId(podPublicIdBytes, userPublicIdBytes)` (`"p_" + 12 hex chars`).
   - NO pod, group message, 1:1 DM, reaction, poll, invite, publicized directory, or WebSocket payload ever exposes `userId`, `userPublicId`, `email`, `fullName`, `gender`, or `nationalityCode`.
3. **1:1 DM Confidentiality Inside a Pod**:
   - Every 1:1 DM row in `messages` stores `recipient_user_id > 0`, `dm_user_low_id = LEAST(sender_user_id, recipient_user_id)`, and `dm_user_high_id = GREATEST(sender_user_id, recipient_user_id)`.
   - WebSocket events (`message_created`, `message_updated`, `message_deleted`, `reaction_updated`, `pin_updated`, `typing_update`), REST message reads/mutations, search (`GET /api/pods/{podId}/search`), and DM attachment downloads (`GET /api/attachments/{id}`) MUST strictly enforce that the caller is one of `{dm_user_low_id, dm_user_high_id}` (`403` otherwise) and deliver WS frames **ONLY** to `{dm_user_low_id, dm_user_high_id}`!

---

## Exact Database DDL (`db/migrations/001_init.sql`)
Tables (all `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`, zero `pod_channels`):
- `users`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `public_id BINARY(16) UNIQUE`, `email VARCHAR(190) UNIQUE`, `password_hash VARCHAR(100)`, `full_name VARCHAR(100)`, `gender VARCHAR(32)`, `nationality_code CHAR(2)`, `plan_tier VARCHAR(16) DEFAULT 'FREE'`, `created_at DATETIME`, `updated_at DATETIME`
- `interests`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `slug VARCHAR(64) UNIQUE`, `label VARCHAR(64)`, `category VARCHAR(32)`, `created_at DATETIME`
- `user_interests`: `(user_id, interest_id)` PK, `created_at DATETIME`, `KEY idx_user_interests_interest (interest_id, user_id)`
- `pods`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `public_id BINARY(16) UNIQUE`, `interest_id BIGINT UNSIGNED`, `code VARCHAR(32)`, `member_count TINYINT UNSIGNED DEFAULT 0`, `max_members TINYINT UNSIGNED DEFAULT 25`, `is_open TINYINT UNSIGNED DEFAULT 1`, `title VARCHAR(80) DEFAULT ''`, `description VARCHAR(280) DEFAULT ''`, `governance_mode VARCHAR(16) DEFAULT 'DEMOCRATIC'`, `owner_user_id BIGINT UNSIGNED DEFAULT 0`, `is_publicized TINYINT UNSIGNED DEFAULT 0`, `allow_random_match TINYINT UNSIGNED DEFAULT 1`, `created_at DATETIME`, `KEY idx_pods_match (interest_id, is_open, member_count, id)`, `KEY idx_pods_publicized (is_publicized, interest_id, member_count, id DESC)`
- `pod_members`: `(pod_id, user_id)` PK, `alias VARCHAR(32)`, `alias_color VARCHAR(16)`, `custom_status VARCHAR(80) DEFAULT ''`, `in_voice TINYINT UNSIGNED DEFAULT 0`, `role VARCHAR(12) DEFAULT 'MEMBER'`, `joined_at DATETIME`, `KEY idx_pod_members_user (user_id, pod_id)`
- `pod_opt_outs`: `(user_id, pod_id)` PK, `left_at DATETIME`
- `messages`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `pod_id BIGINT UNSIGNED`, `sender_user_id BIGINT UNSIGNED DEFAULT 0`, `sender_alias VARCHAR(32)`, `sender_color VARCHAR(16)`, `recipient_user_id BIGINT UNSIGNED DEFAULT 0`, `recipient_alias VARCHAR(32) DEFAULT ''`, `dm_user_low_id BIGINT UNSIGNED DEFAULT 0`, `dm_user_high_id BIGINT UNSIGNED DEFAULT 0`, `quote_message_id BIGINT UNSIGNED DEFAULT 0`, `msg_type TINYINT UNSIGNED DEFAULT 1` (`1=TEXT`, `2=SYSTEM`, `3=POLL`, `4=VOICE_NOTE`, `5=ICEBREAKER`, `6=GOVERNANCE`), `body VARCHAR(4000)`, `is_pinned TINYINT UNSIGNED DEFAULT 0`, `is_deleted TINYINT UNSIGNED DEFAULT 0`, `edited_at DATETIME NULL`, `created_at DATETIME`,
  - `KEY idx_messages_convo_cursor (pod_id, dm_user_low_id, dm_user_high_id, id DESC)` (covers BOTH Group Chat `(pod_id, 0, 0, id DESC)` and 1:1 DMs `(pod_id, low, high, id DESC)`!)
  - `KEY idx_messages_dm_low (pod_id, dm_user_low_id, id DESC)`
  - `KEY idx_messages_dm_high (pod_id, dm_user_high_id, id DESC)`
  - `KEY idx_messages_pod_pinned (pod_id, dm_user_low_id, is_pinned, id DESC)`
  - `FULLTEXT KEY ft_messages_body (body)`
- `message_reactions`: `(message_id, emoji, user_id)` PK, `reactor_alias VARCHAR(32)`, `created_at DATETIME`
- `user_bookmarks`: `(user_id, message_id)` PK, `pod_id BIGINT UNSIGNED`, `created_at DATETIME`
- `message_attachments`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `message_id BIGINT UNSIGNED DEFAULT 0`, `pod_id BIGINT UNSIGNED`, `uploader_user_id BIGINT UNSIGNED`, `kind VARCHAR(16)`, `file_name VARCHAR(180)`, `mime_type VARCHAR(80)`, `size_bytes INT UNSIGNED`, `duration_ms INT UNSIGNED DEFAULT 0`, `storage_path VARCHAR(255)`, `created_at DATETIME`, `KEY idx_attachments_message (message_id)`
- `polls`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `message_id BIGINT UNSIGNED UNIQUE`, `question VARCHAR(240)`, `options_json JSON`, `is_closed TINYINT UNSIGNED DEFAULT 0`, `created_at DATETIME`
- `poll_votes`: `(poll_id, user_id)` PK, `option_index TINYINT UNSIGNED`, `voter_alias VARCHAR(32)`, `created_at DATETIME`
- `pod_invites`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `pod_id BIGINT UNSIGNED`, `code VARCHAR(24) UNIQUE`, `created_by_user_id BIGINT UNSIGNED`, `created_by_alias VARCHAR(32)`, `max_uses INT UNSIGNED DEFAULT 0`, `uses_count INT UNSIGNED DEFAULT 0`, `is_revoked TINYINT UNSIGNED DEFAULT 0`, `expires_at DATETIME NULL`, `created_at DATETIME`, `KEY idx_pod_invites_pod_active (pod_id, is_revoked, id DESC)`
- `pod_proposals`: `id BIGINT UNSIGNED PK AUTO_INCREMENT`, `pod_id BIGINT UNSIGNED`, `proposer_user_id BIGINT UNSIGNED`, `proposer_alias VARCHAR(32)`, `kind VARCHAR(32)`, `title VARCHAR(180)`, `payload_json JSON`, `target_user_id BIGINT UNSIGNED DEFAULT 0`, `target_alias VARCHAR(32) DEFAULT ''`, `status VARCHAR(16) DEFAULT 'OPEN'`, `yes_count SMALLINT UNSIGNED DEFAULT 0`, `no_count SMALLINT UNSIGNED DEFAULT 0`, `eligible_count SMALLINT UNSIGNED DEFAULT 1`, `announcement_message_id BIGINT UNSIGNED DEFAULT 0`, `expires_at DATETIME`, `resolved_at DATETIME NULL`, `created_at DATETIME`, `KEY idx_proposals_pod_status (pod_id, status, id DESC)`, `KEY idx_proposals_open_exp (status, expires_at)`
- `pod_proposal_votes`: `(proposal_id, user_id)` PK, `voter_alias VARCHAR(32)`, `vote TINYINT UNSIGNED`, `created_at DATETIME`

---

## Exact REST API Contract (`camelCase` JSON)

### 1. Auth & Attachments (`com.canopy.auth` & `com.canopy.media`)
- Unchanged `/api/auth/register`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`, `/api/auth/plan`.
- `POST /api/pods/{podId}/attachments` & `GET /api/attachments/{attachmentId}`:
  - In `GET /api/attachments/{attachmentId}`, if `message_id > 0` and that message has `dm_user_low_id > 0`, verify `principal.userId() == dm_user_low_id || principal.userId() == dm_user_high_id` (else `SecurityException` -> `403`)!

### 2. Blind Pods, Matching, Invites, Governance & Pro Groups (`com.canopy.pods`)
- **Removed channel endpoints**: NO `POST /api/pods/{podId}/channels`, NO `DELETE /api/pods/{podId}/channels/{channelId}`, NO `ChannelDto`.
- **`PodDetailDto` shape**:
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
    "isOpen": true,
    "myPeerId": "p_9f81a204bc11",
    "myAlias": "Cobalt Fox",
    "myColor": "#1f6b3a",
    "myRole": "MEMBER",
    "myStatus": "",
    "memberCount": 5,
    "maxMembers": 25,
    "openProposalsCount": 1,
    "dmConversations": [
      {
        "peerId": "p_4d218a901c22",
        "peerAlias": "Jade Owl",
        "peerColor": "#0f766e",
        "online": true,
        "lastMessageId": 142,
        "lastBody": "Down for co-op at 22:00?",
        "lastSenderPeerId": "p_4d218a901c22",
        "lastSenderAlias": "Jade Owl",
        "lastCreatedAt": "2026-11-23T17:15:00Z"
      }
    ],
    "members": [
      {
        "peerId": "p_9f81a204bc11",
        "alias": "Cobalt Fox",
        "color": "#1f6b3a",
        "role": "MEMBER",
        "customStatus": "",
        "online": true,
        "inVoice": false,
        "isSelf": true
      }
    ]
  }
  ```
- **Governance Proposals (`POST /api/pods/{podId}/proposals`, `GET /api/pods/{podId}/proposals`, `POST /api/proposals/{id}/vote`, `POST /api/proposals/{id}/resolve`)**:
  - Allowed `kind` values (zero channel kinds!):
    `KICK_MEMBER` | `RENAME_POD` | `UPDATE_TOPIC` | `CHANGE_CAPACITY` | `TOGGLE_LOCK` | `PIN_MESSAGE`
  - Posts `msgType = "GOVERNANCE"` (`msg_type = 6`) directly into the Pod Group Chat (`recipient_user_id = 0`).

### 3. Group Chat + 1:1 Private Member Messages (`com.canopy.chat`)
- **Pod Group Chat**:
  - `GET /api/pods/{podId}/messages?beforeId=0&limit=40` -> `{ "messages": [ RichMessageDto ], "nextBeforeId": 0 }` (chronological `oldest -> newest` of page, `dm_user_low_id = 0 AND dm_user_high_id = 0`).
  - `POST /api/pods/{podId}/messages` -> Req `{ "body": "...", "quoteMessageId": 0, "attachmentIds": [] }` -> supports `/poll`, `/icebreaker`, `/shrug`, `/status`, attachments, voice notes, inline `quoteMessageId` (referencing a Group message in the same pod). Broadcasts `message_created` to all pod members! Res `201`: `{ "message": RichMessageDto | null, "commandHandled": String? }`.
- **1:1 Private Member DMs (inside `podId`, addressed by `peerId`)**:
  - `GET /api/pods/{podId}/dms` -> `{ "conversations": [ DmSummaryDto ] }` (ordered by `lastMessageId DESC`).
  - `GET /api/pods/{podId}/dms/{peerId}/messages?beforeId=0&limit=40` -> verifies caller and `peerId` are both members of `podId` (and `peerUserId != caller.userId`), returns `{ "messages": [ RichMessageDto ], "nextBeforeId": 0 }`.
  - `POST /api/pods/{podId}/dms/{peerId}/messages` -> Req `{ "body": "...", "quoteMessageId": 0, "attachmentIds": [] }` -> inserts private message (`recipient_user_id = peerUserId`, `recipient_alias = peerAlias`, `dm_user_low_id = min(caller, peer)`, `dm_user_high_id = max(caller, peer)`). Supports `/shrug`, `/status`, attachments, voice notes, and `quoteMessageId` (referencing a message in that **same** 1:1 DM pair only!). Sends `message_created` over WebSocket **ONLY** to `setOf(caller.userId, peerUserId)`! Res `201`: `{ "message": RichMessageDto | null, "commandHandled": String? }`.
- **`RichMessageDto` shape**:
  ```json
  {
    "id": 105,
    "podId": "0193...",
    "senderPeerId": "p_9f81a204bc11",
    "senderAlias": "Cobalt Fox",
    "senderColor": "#1f6b3a",
    "recipientPeerId": null,
    "recipientAlias": null,
    "quoteMessage": null,
    "msgType": "TEXT",
    "body": "Anyone up for **co-op** tonight? ||No spoilers||",
    "isPinned": false,
    "isBookmarked": false,
    "isDeleted": false,
    "editedAt": null,
    "createdAt": "2026-11-23T17:45:00Z",
    "reactions": [
      { "emoji": "🔥", "count": 2, "aliases": ["Cobalt Fox", "Amber Heron"], "meReacted": true }
    ],
    "attachments": [],
    "poll": null,
    "proposal": null
  }
  ```
- **Message Actions**:
  - `PATCH /api/messages/{messageId}`, `DELETE /api/messages/{messageId}`, `POST /api/messages/{messageId}/reactions`, `POST /api/messages/{messageId}/pin`, `POST /api/messages/{messageId}/bookmark`, `POST /api/polls/{pollId}/vote`
  - If message is a 1:1 DM (`dm_user_low_id > 0`), strictly verify caller is `dm_user_low_id` or `dm_user_high_id` (`403` otherwise) and send WS updates (`message_updated`, `message_deleted`, `reaction_updated`, `pin_updated`) **ONLY** to `{dm_user_low_id, dm_user_high_id}`!
- **Pins, Bookmarks & Search**:
  - `GET /api/pods/{podId}/pins` -> Group Chat pinned messages (`dm_user_low_id = 0`).
  - `GET /api/bookmarks` -> Caller's saved messages across pods (Group + caller's own DMs).
  - `GET /api/pods/{podId}/search?q=...` -> Searches `pod_id = :podId AND (dm_user_low_id = 0 OR dm_user_low_id = :myUserId OR dm_user_high_id = :myUserId)` via `FULLTEXT` (`MATCH(m.body) AGAINST(...)` / `LIKE` fallback) — NEVER returns other members' private DMs!

---

## Exact Native WebSocket Contract (`/ws/pods/{podId}?token=<jwt>`)

### Client -> Server JSON frames (`"type"`):
- `{ "type": "typing", "targetPeerId": null | "p_...", "isTyping": true }` (`null` = Group Chat; `"p_..."` = 1:1 DM typing sent ONLY to `targetPeerId` + self)
- `{ "type": "voice_join", "muted": false, "deafened": false }` (joins the Pod's single shared Audio Call)
- `{ "type": "voice_leave" }`
- `{ "type": "voice_state", "muted": false, "deafened": false, "speaking": true }`
- `{ "type": "webrtc_signal", "targetPeerId": "p_...", "signal": { ... } }`
- `{ "type": "ping" }`

### Server -> Client JSON frames (`"type"`):
- `{ "type": "presence_snapshot", "podId": "0193...", "selfPeerId": "p_...", "onlinePeerIds": ["p_..."], "members": [ MemberDto ], "voicePeers": [ VoicePeerDto ] }`
- `{ "type": "typing_update", "targetPeerId": null | "p_...", "fromPeerId": null | "p_...", "typingAliases": ["Cobalt Fox"] }` (`targetPeerId == null` -> Group Chat typing; when 1:1 DM typing, `fromPeerId` is the peer typing to the recipient and `targetPeerId` is the recipient's `peerId`)
- `{ "type": "message_created", "message": RichMessageDto }`
- `{ "type": "message_updated", "message": RichMessageDto }`
- `{ "type": "message_deleted", "messageId": 105, "senderPeerId": "p_...", "recipientPeerId": null | "p_..." }`
- `{ "type": "reaction_updated", "message": RichMessageDto }`
- `{ "type": "pin_updated", "message": RichMessageDto }`
- `{ "type": "poll_updated", "message": RichMessageDto }`
- `{ "type": "member_joined", "member": MemberDto }`
- `{ "type": "member_left", "peerId": "p_...", "alias": "Cobalt Fox" }`
- `{ "type": "member_kicked", "peerId": "p_...", "alias": "Slate Otter" }`
- `{ "type": "proposal_updated", "proposal": PodProposalDto }`
- `{ "type": "pod_updated", "pod": PodDetailDto }`
- `{ "type": "voice_roster_updated", "voicePeers": [ VoicePeerDto ] }`
- `{ "type": "webrtc_signal", "fromPeerId": "p_...", "fromAlias": "Cobalt Fox", "signal": { ... } }`
- `{ "type": "pong" }`

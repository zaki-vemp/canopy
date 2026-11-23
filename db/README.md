# Canopy Database Architecture (MySQL 8.0 & PlanetScale Vitess)

## Files
- `migrations/001_init.sql` — 15-table InnoDB schema (`utf8mb4_0900_ai_ci`, `BIGINT UNSIGNED` PKs, `BINARY(16)` UUIDv7 public IDs, `DATETIME`, zero `pod_channels`, zero `ENUM`/triggers/stored procedures/FK DDL).
- `seed.sql` — Idempotent seed of the 12 default interests (`ON DUPLICATE KEY UPDATE`).
- `vschema.json` — PlanetScale Vitess VSchema (reference `interests`, user-sharded auth/profile tables, pod-sharded room/chat/DM/poll/governance tables, sequence + lookup vindexes).
- `verify_explain.sql` — Reproducible `EXPLAIN` + `EXPLAIN ANALYZE` benchmark across all 8 hot OLTP paths with clean teardown.

## Schema & Sharding Rationale
1. **Clustered PKs vs. External IDs**: All entity tables cluster on monotonic `BIGINT UNSIGNED AUTO_INCREMENT` (8 bytes) for sequential InnoDB B-tree appends without random page splits, saving 8 bytes per secondary index entry compared to 16-byte UUID PKs. Public identifiers (`users.public_id`, `pods.public_id`) use time-ordered UUIDv7 in `BINARY(16)` secondary `UNIQUE` indexes.
2. **Pure Chat Model (1 Pod Group Chat + 1:1 Member DMs)**:
   - Group Chat messages store `recipient_user_id = 0`, `dm_user_low_id = 0`, `dm_user_high_id = 0`.
   - 1:1 Private Member DMs store `recipient_user_id > 0`, `dm_user_low_id = LEAST(sender_user_id, recipient_user_id)`, and `dm_user_high_id = GREATEST(sender_user_id, recipient_user_id)`.
   - Pod audio call state is tracked directly on `pod_members.in_voice` (`TINYINT UNSIGNED`).
3. **Equality-First Composite Indexes**:
   - `idx_users_email (email)` — `const` lookup for login/registration.
   - `idx_pods_match (interest_id, is_open, member_count, id)` — filters open democratic pods by interest (`ref`) + `pod_opt_outs` `PRIMARY` anti-join (`Not exists; Using index`).
   - `idx_pods_publicized (is_publicized, interest_id, member_count, id DESC)` — backward index scan (`ref`) for publicized Canopy Pro communities with zero `Using filesort`.
   - `idx_messages_convo_cursor (pod_id, dm_user_low_id, dm_user_high_id, id DESC)` — keyset cursor pagination (`id < ?`) for **both** Pod Group Chat (`dm_user_low_id = 0, dm_user_high_id = 0`) and 1:1 Member DMs (`dm_user_low_id = low, dm_user_high_id = high`) with zero `OFFSET` or `Using filesort`, plus covering group-aggregate (`Using index`) for low-side DM summaries.
   - `idx_messages_dm_low (pod_id, dm_user_low_id, id DESC)` & `idx_messages_dm_high (pod_id, dm_user_high_id, id DESC)` — narrow `ref` lookups to build per-member 1:1 DM conversation summaries (`lastMessageId DESC`).
   - `idx_messages_pod_pinned (pod_id, dm_user_low_id, is_pinned, id DESC)` — Group Chat pinned messages (`dm_user_low_id = 0, is_pinned = 1`) ordered by `id DESC` with zero `Using filesort`.
   - `ft_messages_body (body)` — InnoDB `FULLTEXT` index for pod-scoped `IN BOOLEAN MODE` search filtered strictly to `(dm_user_low_id = 0 OR dm_user_low_id = :myUserId OR dm_user_high_id = :myUserId)`.
4. **PlanetScale Vitess VSchema (`vschema.json`)**:
   - **Reference**: `interests` (`type: "reference"`, replicated from `canopy_lookup.interests`) serves joins locally per shard.
   - **User-sharded (`user_id_xxhash`)**: `users`, `user_interests`, `pod_opt_outs`, `user_bookmarks`.
   - **Pod-sharded (`pod_id_xxhash` + owned lookup vindexes)**: `pods`, `pod_members`, `messages`, `message_attachments`, `pod_invites`, `pod_proposals`, plus `message_reactions` / `polls` (co-located via `messages_id_lookup`), `poll_votes` (via `polls_id_lookup`), and `pod_proposal_votes` (via `pod_proposals_id_lookup`).

## PII & DM Confidentiality Boundary
- `users` is the **only** table storing private identity (`email`, `password_hash`, `full_name`, `gender`, `nationality_code`) and is queried exclusively by `/api/auth/**`.
- Pod matching (`pods` + `pod_opt_outs`) never inspects `gender` or `nationality_code`.
- `pod_members`, `messages`, `message_reactions`, `poll_votes`, and `pod_proposal_votes` store room-scoped aliases (`Cobalt Fox`, `Jade Owl`, etc.); external payloads expose only deterministic room-scoped `peerId = "p_" + hex12(SHA-256(podPublicId || userPublicId))`.
- 1:1 DM reads, mutations, search, typing indicators, WebSocket broadcasts, and attachment downloads strictly enforce participant membership in `{dm_user_low_id, dm_user_high_id}`.

## Connection Pooling (HikariCP & VTGate)
Configured in `backend/src/main/resources/application.yml`:
- `maximum-pool-size: 20`, `minimum-idle: 5` (`cores * N` OLTP baseline).
- `max-lifetime: 240000` (4m) and `idle-timeout: 120000` (2m) — recycled safely below server `wait_timeout = 300s` and VTGate idle timeouts.
- `connection-timeout: 5000` — fast fail under saturation.

## Online DDL Rollout
- **PlanetScale / Vitess**: Run migrations via PlanetScale Deploy Requests or `SET @@ddl_strategy = 'vitess';`.
- **Self-Hosted MySQL 8.0**: Specify explicit algorithm and lock safety:
  ```sql
  ALTER TABLE messages ADD COLUMN dm_user_low_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    ALGORITHM=INSTANT;

  ALTER TABLE messages ADD INDEX idx_messages_convo_cursor (pod_id, dm_user_low_id, dm_user_high_id, id DESC),
    ALGORITHM=INPLACE, LOCK=NONE;
  ```

## Verified `EXPLAIN` & `EXPLAIN ANALYZE` Plans (MySQL 8.0)

Captured via `docker exec -i murnel-mysql mysql --table -ucanopy -pcanopy_dev_pw canopy < db/verify_explain.sql`:

| # | Hot Query | Access Type | Chosen Index | `key_len` | Extra | `EXPLAIN ANALYZE` Actual Time |
|---|---|---|---|---|---|---|
| Q1 | Auth login (`WHERE email = ?`) | `const` | `idx_users_email` | `762` | `NULL` | `0.0002 ms` (`rows=1`) |
| Q2 | Blind pod match + `pod_opt_outs` anti-join | `ref` + `eq_ref` | `idx_pods_match` + `PRIMARY` | `9` / `16` | `Not exists; Using index` | `0.095 ms` (`rows=2`) |
| Q3 | Group Chat cursor (`pod_id = ? AND dm_user_low_id = 0 AND dm_user_high_id = 0 AND id < ? ORDER BY id DESC LIMIT 40`) | `range` | `idx_messages_convo_cursor` | `32` | `Using index condition` (zero filesort) | `0.349 ms` (`rows=40`) |
| Q4 | 1:1 Member DM cursor (`pod_id = ? AND dm_user_low_id = ? AND dm_user_high_id = ? AND id < ? ORDER BY id DESC LIMIT 40`) | `range` | `idx_messages_convo_cursor` | `32` | `Using index condition` (zero filesort) | `0.252 ms` (`rows=40`) |
| Q5 | 1:1 DM conversation summary (`UNION ALL` low + high) | `ref` + `ref` | `idx_messages_convo_cursor` + `idx_messages_dm_high` | `16` / `16` | `Using index` / `Using where` | `0.521 ms` (`rows=2`) |
| Q6 | Group Chat pins (`pod_id = ? AND dm_user_low_id = 0 AND is_pinned = 1 ORDER BY id DESC`) | `ref` | `idx_messages_pod_pinned` | `17` | `Using where` (zero filesort) | `0.046 ms` (`rows=2`) |
| Q7 | Publicized directory (`is_publicized = 1 AND interest_id = ? ORDER BY member_count DESC, id ASC`) | `ref` | `idx_pods_publicized` | `9` | `Backward index scan` (zero filesort) | `0.041 ms` (`rows=1`) |
| Q8 | Pod search + DM privacy (`MATCH(body) AGAINST('+Helldivers*' IN BOOLEAN MODE)`) | `fulltext` | `ft_messages_body` | `0` | `Using where; Ft_hints: no_ranking` | `0.688 ms` (`rows=12`) |

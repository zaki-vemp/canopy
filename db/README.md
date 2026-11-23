# Canopy Database Architecture (MySQL 8.0 & PlanetScale Vitess)

## Files
- `migrations/001_init.sql` — 13-table InnoDB schema (`utf8mb4_0900_ai_ci`, `BIGINT UNSIGNED` PKs, `BINARY(16)` UUIDv7 public IDs, `DATETIME`, zero `ENUM`/triggers/stored procedures/FK DDL).
- `seed.sql` — Idempotent seed of the 12 default interest channels (`ON DUPLICATE KEY UPDATE`).
- `vschema.json` — PlanetScale Vitess VSchema (reference `interests`, user-sharded auth/profile tables, pod-sharded room/chat/poll tables, sequence + lookup vindexes).
- `verify_explain.sql` — Reproducible `EXPLAIN` + `EXPLAIN ANALYZE` benchmark across all 5 hot OLTP paths with clean teardown.

## Schema & Sharding Rationale
1. **Clustered PKs vs. External IDs**: All entity tables cluster on monotonic `BIGINT UNSIGNED AUTO_INCREMENT` (8 bytes) for sequential InnoDB B-tree appends without random page splits, and save 8 bytes per secondary index entry compared to 16-byte UUID PKs. Public identifiers (`users.public_id`, `pods.public_id`, `pod_channels.public_id`) use time-ordered UUIDv7 in `BINARY(16)` secondary `UNIQUE` indexes.
2. **Equality-First Composite Indexes**:
   - `idx_users_email (email)` — `const` lookup for login/registration.
   - `idx_pods_match (interest_id, is_open, member_count, id)` — filters open pods by interest (`ref`) and covers open-pod/member counts for `GET /api/interests` (`Using index`).
   - `idx_messages_channel_cursor (channel_id, parent_message_id, id DESC)` — keyset cursor pagination (`id < ?`) for top-level channel feeds (`parent_message_id = 0`) with zero `OFFSET` or `Using filesort`.
   - `idx_messages_thread_cursor (parent_message_id, id ASC)` — chronological Slack thread drawer reads with zero `Using filesort`.
   - `ft_messages_body (body)` — InnoDB `FULLTEXT` index for pod-scoped `IN BOOLEAN MODE` search (`innodb_ft_min_token_size = 3`; `<3`-char or hyphen-split sub-tokens like `co-op` fall back to pod-scoped `LIKE` in app code).
3. **PlanetScale Vitess VSchema (`vschema.json`)**:
   - **Reference**: `interests` (`type: "reference"`, replicated from `canopy_lookup.interests`) serves joins locally per shard.
   - **User-sharded (`user_id_xxhash`)**: `users`, `user_interests`, `pod_opt_outs`, `user_bookmarks`.
   - **Pod-sharded (`pod_id_xxhash` + owned lookup vindexes)**: `pods`, `pod_channels`, `pod_members`, `messages`, `message_attachments`, plus `message_reactions` / `polls` (co-located on the parent pod shard via `messages_id_lookup`) and `poll_votes` (co-located via `polls_id_lookup`).

## PII Isolation Boundary
- `users` is the **only** table storing private identity (`email`, `password_hash`, `full_name`, `gender`, `nationality_code`) and is queried exclusively by `/api/auth/*`.
- Pod matching (`pods` + `pod_opt_outs`) never inspects `gender` or `nationality_code`.
- `pod_members`, `messages`, `message_reactions`, and `poll_votes` store room-scoped aliases (`Cobalt Fox`, `Amber Heron`, etc.); external payloads expose only deterministic room-scoped `peerId = "p_" + hex12(SHA-256(podPublicId || userPublicId))`.

## Connection Pooling (HikariCP & VTGate)
Configured in `backend/src/main/resources/application.yml`:
- `maximum-pool-size: 20`, `minimum-idle: 5` (`cores * N` OLTP baseline; prevents thread/mutex thrashing on native MySQL `max_connections = 151`).
- `max-lifetime: 240000` (4m) and `idle-timeout: 120000` (2m) — recycled safely below server `wait_timeout = 300s` and VTGate idle timeouts.
- `connection-timeout: 5000` — fast fail under saturation. On PlanetScale, VTGate multiplexes app pools onto VTTablet backend pools.

## Online DDL Rollout
- **PlanetScale / Vitess**: Run migrations via PlanetScale Deploy Requests or `SET @@ddl_strategy = 'vitess';` (non-blocking VReplication shadow copy, trackable via `SHOW VITESS_MIGRATIONS`, revertible via `REVERT VITESS_MIGRATION '<uuid>'`).
- **Self-Hosted MySQL 8.0**: Always specify explicit algorithm and lock safety so MySQL fails fast instead of falling back to blocking `COPY`:
  ```sql
  -- Metadata-only column addition (MySQL 8.0.29+)
  ALTER TABLE messages ADD COLUMN metadata_flags TINYINT UNSIGNED NOT NULL DEFAULT 0,
    ALGORITHM=INSTANT;

  -- Concurrent secondary index creation without blocking DML
  ALTER TABLE messages ADD INDEX idx_messages_pod_pinned (pod_id, is_pinned, id DESC),
    ALGORITHM=INPLACE, LOCK=NONE;
  ```

## Verified `EXPLAIN` & `EXPLAIN ANALYZE` Plans (MySQL 8.0.46)

Captured via `docker exec -i canopy-mysql mysql --table -ucanopy -pcanopy_dev_pw canopy < db/verify_explain.sql`:

| # | Hot Query | Access Type | Chosen Index | `key_len` | Extra | `EXPLAIN ANALYZE` Actual Time |
|---|---|---|---|---|---|---|
| Q1 | Auth login (`WHERE email = ?`) | `const` | `idx_users_email` | `762` | `NULL` | `0.00017 ms` (`rows=1`) |
| Q2 | Blind pod match + `pod_opt_outs` anti-join | `ref` + `eq_ref` | `idx_pods_match` + `PRIMARY` | `9` / `16` | `Not exists; Using index` | `0.045 ms` (`rows=2`) |
| Q3 | Channel cursor (`channel_id = ? AND parent_message_id = 0 AND id < ? ORDER BY id DESC LIMIT 40`) | `range` | `idx_messages_channel_cursor` | `24` | `Using index condition` (zero filesort) | `0.237 ms` (`rows=40`) |
| Q4 | Slack thread drawer (`WHERE parent_message_id = ? ORDER BY id ASC`) | `ref` | `idx_messages_thread_cursor` | `8` | `NULL` (zero filesort) | `0.049 ms` (`rows=12`) |
| Q5 | Pod search (`WHERE pod_id = ? AND MATCH(body) AGAINST('+co-op*' IN BOOLEAN MODE)`) | `fulltext` | `ft_messages_body` | `0` | `Using where; Ft_hints: no_ranking` | `0.006 ms` |

```text
-- Q1: Auth login lookup
-> Rows fetched before execution  (cost=0..0 rows=1) (actual time=89e-6..170e-6 rows=1 loops=1)

-- Q2: Blind pod match + opt-out anti-join
-> Limit: 5 row(s)  (cost=1.2 rows=1) (actual time=0.034..0.045 rows=2 loops=1)
    -> Filter: (poo.pod_id is null)  (cost=1.2 rows=1) (actual time=0.0335..0.0442 rows=2 loops=1)
        -> Nested loop antijoin  (cost=1.2 rows=1) (actual time=0.0326..0.0431 rows=2 loops=1)
            -> Filter: (p.member_count < p.max_members)  (cost=0.85 rows=1) (actual time=0.0257..0.0298 rows=3 loops=1)
                -> Index lookup on p using idx_pods_match (interest_id=(@ve_gaming_id), is_open=1)  (cost=0.85 rows=3) (actual time=0.0245..0.028 rows=3 loops=1)
            -> Single-row covering index lookup on poo using PRIMARY (user_id=(@ve_user_id), pod_id=p.id)  (cost=0.35 rows=1) (actual time=0.00377..0.00377 rows=0.333 loops=3)

-- Q3: Channel cursor pagination (zero filesort)
-> Limit: 40 row(s)  (cost=22.3 rows=40) (actual time=0.0601..0.237 rows=40 loops=1)
    -> Index range scan on messages using idx_messages_channel_cursor over (channel_id = 1 AND parent_message_id = 0 AND 1593 < id), with index condition: ((messages.parent_message_id = 0) and (messages.channel_id = <cache>((@ve_channel_id))) and (messages.id < <cache>((@ve_cursor_id))))  (cost=22.3 rows=49) (actual time=0.0595..0.233 rows=40 loops=1)

-- Q4: Slack thread drawer query (zero filesort)
-> Index lookup on messages using idx_messages_thread_cursor (parent_message_id=(@ve_parent_msg_id))  (cost=4.2 rows=12) (actual time=0.0241..0.0489 rows=12 loops=1)

-- Q5: Boolean FULLTEXT search
-> Limit: 20 row(s)  (cost=0.26 rows=0.1) (actual time=0.00614..0.00614 rows=0 loops=1)
    -> Filter: ((messages.pod_id = <cache>((@ve_pod_id))) and (match messages.body against ('+co-op*' in boolean mode)))  (cost=0.26 rows=0.1) (actual time=0.00569..0.00569 rows=0 loops=1)
        -> Full-text index search on messages using ft_messages_body (body='+co-op*')  (cost=0.26 rows=1) (actual time=0.005..0.005 rows=0 loops=1)
```

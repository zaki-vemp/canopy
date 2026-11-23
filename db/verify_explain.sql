-- Verify EXPLAIN and EXPLAIN ANALYZE plans for all 8 hot Canopy OLTP queries.
-- Commits realistic multi-pod Group Chat + 1:1 private DM rows so InnoDB flushes
-- FULLTEXT inverted indexes and statistics, runs EXPLAIN + EXPLAIN ANALYZE, then
-- cleans up all synthetic rows (leaving `canopy` with only the 12 seeded `interests`).

-- 1. Synthetic users (64 rows; private auth PII strictly isolated in `users`)
INSERT INTO users (public_id, email, password_hash, full_name, gender, nationality_code, plan_tier)
WITH RECURSIVE seq(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 64
)
SELECT UNHEX(CONCAT('0193456789abcdef7000', LPAD(HEX(n), 12, '0'))),
       CONCAT('verify-user-', n, '@canopy.test'),
       '$2a$10$7EqJtq98hPqEX7fNZaFWoOHi6M2W8r6Z9x0y1z2a3b4c5d6e7f8g9',
       CONCAT('Verify User ', n),
       ELT((n MOD 3) + 1, 'female', 'male', 'non-binary'),
       ELT((n MOD 4) + 1, 'IN', 'US', 'DE', 'JP'),
       IF(n = 1, 'PREMIUM', 'FREE')
FROM seq;

SET @ve_user_id   := (SELECT id FROM users WHERE email = 'verify-user-1@canopy.test');
SET @ve_peer_b_id := (SELECT id FROM users WHERE email = 'verify-user-2@canopy.test');
SET @ve_peer_c_id := (SELECT id FROM users WHERE email = 'verify-user-3@canopy.test');
SET @ve_gaming_id := (SELECT id FROM interests WHERE slug = 'gaming');
SET @ve_chess_id  := (SELECT id FROM interests WHERE slug = 'chess');

INSERT INTO user_interests (user_id, interest_id)
VALUES
  (@ve_user_id, @ve_gaming_id),
  (@ve_user_id, @ve_chess_id);

-- 2. Synthetic pods (48 rows: 4 per seeded interest; 3 democratic open, 1 publicized admin)
INSERT INTO pods (
  public_id, interest_id, code, member_count, max_members, is_open,
  title, description, governance_mode, owner_user_id, is_publicized, allow_random_match
)
SELECT UNHEX(CONCAT('0193456789abcdef8000', LPAD(HEX(ROW_NUMBER() OVER (ORDER BY i.id, k.n)), 12, '0'))),
       i.id,
       CONCAT('ve-pod-', 9000 + ROW_NUMBER() OVER (ORDER BY i.id, k.n)),
       IF(k.n = 4, 12, k.n + 2),
       25,
       1,
       IF(k.n = 4, CONCAT(i.label, ' Guild'), ''),
       IF(k.n = 4, 'Publicized pro community', ''),
       IF(k.n = 4, 'ADMIN', 'DEMOCRATIC'),
       IF(k.n = 4, @ve_user_id, 0),
       IF(k.n = 4, 1, 0),
       IF(k.n = 4, 0, 1)
FROM interests i
CROSS JOIN (
  SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
) k;

SET @ve_pod_id := (
  SELECT MIN(id) FROM pods
  WHERE code LIKE 've-pod-%' AND interest_id = @ve_gaming_id AND governance_mode = 'DEMOCRATIC'
);
SET @ve_opted_out_pod_id := (
  SELECT MIN(id) FROM pods
  WHERE code LIKE 've-pod-%' AND interest_id = @ve_gaming_id AND governance_mode = 'DEMOCRATIC' AND id > @ve_pod_id
);

-- 3. Peer-blind pod members + opt-out row for anti-join verification
INSERT INTO pod_members (pod_id, user_id, alias, alias_color, custom_status, in_voice, role)
SELECT p.id,
       @ve_user_id + 4 + (ROW_NUMBER() OVER (ORDER BY p.id) MOD 50),
       ELT((p.id MOD 4) + 1, 'Cobalt Fox', 'Amber Heron', 'Slate Otter', 'Mint Owl'),
       '#1f6b3a',
       'Ready for co-op',
       0,
       'MEMBER'
FROM pods p
WHERE p.code LIKE 've-pod-%';

INSERT INTO pod_members (pod_id, user_id, alias, alias_color, custom_status, in_voice, role)
VALUES
  (@ve_pod_id, @ve_user_id,   'Cobalt Fox',  '#1f6b3a', 'Hosting lobby', 1, 'MEMBER'),
  (@ve_pod_id, @ve_peer_b_id, 'Jade Owl',    '#0f766e', 'Down for raids', 1, 'MEMBER'),
  (@ve_pod_id, @ve_peer_c_id, 'Slate Otter', '#334155', 'AFK', 0, 'MEMBER');

INSERT INTO pod_opt_outs (user_id, pod_id)
VALUES (@ve_user_id, @ve_opted_out_pod_id);

-- 4. Realistic interleaved Group Chat messages across 8 pods (2,400 rows, dm_user_low_id = 0)
INSERT INTO messages (
  pod_id, sender_user_id, sender_alias, sender_color,
  recipient_user_id, recipient_alias, dm_user_low_id, dm_user_high_id,
  quote_message_id, msg_type, body, is_pinned
)
WITH RECURSIVE a(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM a WHERE n < 300
),
b(m) AS (
  SELECT 0 UNION ALL SELECT m + 1 FROM b WHERE m < 7
)
SELECT @ve_pod_id + m,
       @ve_user_id + ((n + m) MOD 16),
       ELT(((n + m) MOD 4) + 1, 'Cobalt Fox', 'Jade Owl', 'Slate Otter', 'Mint Owl'),
       '#1f6b3a',
       0,
       '',
       0,
       0,
       0,
       1,
       IF(
         n MOD 25 = 0,
         CONCAT('Anyone up for Helldivers expedition session tonight? Lobby #', n),
         CONCAT('Evening pod group check-in message #', n, ' discussing strategy builds')
       ),
       IF((n = 100 OR n = 200) AND m = 0, 1, 0)
FROM a CROSS JOIN b
ORDER BY n, m;

-- 5. Realistic 1:1 Private Member DMs in @ve_pod_id (160 rows across pairs)
--    Pair 1: (@ve_user_id, @ve_peer_b_id) where @ve_user_id is dm_user_low_id
--    Pair 2: (@ve_peer_b_id, @ve_peer_c_id) where @ve_peer_b_id is dm_user_high_id relative to @ve_user_id in another pair
INSERT INTO messages (
  pod_id, sender_user_id, sender_alias, sender_color,
  recipient_user_id, recipient_alias, dm_user_low_id, dm_user_high_id,
  quote_message_id, msg_type, body, is_pinned
)
WITH RECURSIVE dseq(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM dseq WHERE n < 120
)
SELECT @ve_pod_id,
       IF(n MOD 2 = 0, @ve_user_id, @ve_peer_b_id),
       IF(n MOD 2 = 0, 'Cobalt Fox', 'Jade Owl'),
       IF(n MOD 2 = 0, '#1f6b3a', '#0f766e'),
       IF(n MOD 2 = 0, @ve_peer_b_id, @ve_user_id),
       IF(n MOD 2 = 0, 'Jade Owl', 'Cobalt Fox'),
       LEAST(@ve_user_id, @ve_peer_b_id),
       GREATEST(@ve_user_id, @ve_peer_b_id),
       0,
       1,
       CONCAT('Private 1:1 DM #', n, ' between Cobalt Fox and Jade Owl'),
       0
FROM dseq;

INSERT INTO messages (
  pod_id, sender_user_id, sender_alias, sender_color,
  recipient_user_id, recipient_alias, dm_user_low_id, dm_user_high_id,
  quote_message_id, msg_type, body, is_pinned
)
WITH RECURSIVE dseq2(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM dseq2 WHERE n < 40
)
SELECT @ve_pod_id,
       IF(n MOD 2 = 0, @ve_peer_b_id, @ve_peer_c_id),
       IF(n MOD 2 = 0, 'Jade Owl', 'Slate Otter'),
       '#0f766e',
       IF(n MOD 2 = 0, @ve_peer_c_id, @ve_peer_b_id),
       IF(n MOD 2 = 0, 'Slate Otter', 'Jade Owl'),
       LEAST(@ve_peer_b_id, @ve_peer_c_id),
       GREATEST(@ve_peer_b_id, @ve_peer_c_id),
       0,
       1,
       CONCAT('Confidential DM #', n, ' between Jade Owl and Slate Otter'),
       0
FROM dseq2;

SET @ve_group_cursor_id := (
  SELECT id FROM (
    SELECT id FROM messages
    WHERE pod_id = @ve_pod_id AND dm_user_low_id = 0 AND dm_user_high_id = 0
    ORDER BY id DESC
    LIMIT 1 OFFSET 40
  ) AS gcur
);

SET @ve_dm_low  := LEAST(@ve_user_id, @ve_peer_b_id);
SET @ve_dm_high := GREATEST(@ve_user_id, @ve_peer_b_id);

SET @ve_dm_cursor_id := (
  SELECT id FROM (
    SELECT id FROM messages
    WHERE pod_id = @ve_pod_id AND dm_user_low_id = @ve_dm_low AND dm_user_high_id = @ve_dm_high
    ORDER BY id DESC
    LIMIT 1 OFFSET 30
  ) AS dcur
);

SET @ve_sample_msg_id := (
  SELECT MIN(id) FROM messages
  WHERE pod_id = @ve_pod_id AND dm_user_low_id = 0
);

-- 6. Sample reactions, bookmarks, attachments, polls & votes
INSERT INTO message_reactions (message_id, emoji, user_id, reactor_alias)
VALUES (@ve_sample_msg_id, '🔥', @ve_user_id, 'Cobalt Fox');

INSERT INTO user_bookmarks (user_id, message_id, pod_id)
VALUES (@ve_user_id, @ve_sample_msg_id, @ve_pod_id);

INSERT INTO message_attachments (
  message_id, pod_id, uploader_user_id, kind, file_name, mime_type, size_bytes, duration_ms, storage_path
) VALUES (
  @ve_sample_msg_id, @ve_pod_id, @ve_user_id, 'voice_note', 'voice.webm', 'audio/webm', 18240, 4200, 've-voice.webm'
);

INSERT INTO polls (message_id, question, options_json)
VALUES (@ve_sample_msg_id, 'What co-op game tonight?', JSON_ARRAY('Helldivers', 'Deep Rock'));

SET @ve_poll_id := LAST_INSERT_ID();

INSERT INTO poll_votes (poll_id, user_id, option_index, voter_alias)
VALUES (@ve_poll_id, @ve_user_id, 0, 'Cobalt Fox');

-- Refresh optimizer statistics & FULLTEXT index stats before measuring
ANALYZE TABLE
  users, interests, user_interests, pods, pod_members,
  pod_opt_outs, messages, message_reactions, user_bookmarks,
  message_attachments, polls, poll_votes, pod_invites, pod_proposals, pod_proposal_votes;

-- ============================================================================
-- QUERY 1: Auth login lookup (WHERE email = ? -> idx_users_email)
-- ============================================================================
SELECT '=== Q1: Auth login lookup (WHERE email = ? -> idx_users_email) ===' AS check_name;

EXPLAIN
SELECT id, public_id, email, password_hash, full_name, gender, nationality_code, plan_tier
FROM users
WHERE email = 'verify-user-1@canopy.test';

EXPLAIN ANALYZE
SELECT id, public_id, email, password_hash, full_name, gender, nationality_code, plan_tier
FROM users
WHERE email = 'verify-user-1@canopy.test';

-- ============================================================================
-- QUERY 2: Blind pod match (idx_pods_match + pod_opt_outs PRIMARY)
-- ============================================================================
SELECT '=== Q2: Blind pod match (idx_pods_match + pod_opt_outs PRIMARY) ===' AS check_name;

EXPLAIN
SELECT p.id, p.public_id, p.code, p.member_count, p.max_members
FROM pods p
LEFT JOIN pod_opt_outs poo
  ON poo.user_id = @ve_user_id
 AND poo.pod_id = p.id
WHERE p.interest_id = @ve_gaming_id
  AND p.is_open = 1
  AND p.allow_random_match = 1
  AND p.governance_mode = 'DEMOCRATIC'
  AND p.member_count < p.max_members
  AND poo.pod_id IS NULL
LIMIT 5;

EXPLAIN ANALYZE
SELECT p.id, p.public_id, p.code, p.member_count, p.max_members
FROM pods p
LEFT JOIN pod_opt_outs poo
  ON poo.user_id = @ve_user_id
 AND poo.pod_id = p.id
WHERE p.interest_id = @ve_gaming_id
  AND p.is_open = 1
  AND p.allow_random_match = 1
  AND p.governance_mode = 'DEMOCRATIC'
  AND p.member_count < p.max_members
  AND poo.pod_id IS NULL
LIMIT 5;

-- ============================================================================
-- QUERY 3: Group Chat cursor pagination (idx_messages_convo_cursor, zero filesort)
-- ============================================================================
SELECT '=== Q3: Group Chat cursor pagination (idx_messages_convo_cursor) ===' AS check_name;

EXPLAIN
SELECT id, pod_id, sender_alias, sender_color, msg_type, body,
       is_pinned, is_deleted, edited_at, created_at
FROM messages FORCE INDEX (idx_messages_convo_cursor)
WHERE pod_id = @ve_pod_id
  AND dm_user_low_id = 0
  AND dm_user_high_id = 0
  AND id < @ve_group_cursor_id
ORDER BY id DESC
LIMIT 40;

EXPLAIN ANALYZE
SELECT id, pod_id, sender_alias, sender_color, msg_type, body,
       is_pinned, is_deleted, edited_at, created_at
FROM messages FORCE INDEX (idx_messages_convo_cursor)
WHERE pod_id = @ve_pod_id
  AND dm_user_low_id = 0
  AND dm_user_high_id = 0
  AND id < @ve_group_cursor_id
ORDER BY id DESC
LIMIT 40;

-- ============================================================================
-- QUERY 4: 1:1 Member DM cursor pagination (idx_messages_convo_cursor, zero filesort)
-- ============================================================================
SELECT '=== Q4: 1:1 Member DM cursor pagination (idx_messages_convo_cursor) ===' AS check_name;

EXPLAIN
SELECT id, pod_id, sender_alias, sender_color, recipient_alias, msg_type, body,
       is_pinned, is_deleted, edited_at, created_at
FROM messages FORCE INDEX (idx_messages_convo_cursor)
WHERE pod_id = @ve_pod_id
  AND dm_user_low_id = @ve_dm_low
  AND dm_user_high_id = @ve_dm_high
  AND id < @ve_dm_cursor_id
ORDER BY id DESC
LIMIT 40;

EXPLAIN ANALYZE
SELECT id, pod_id, sender_alias, sender_color, recipient_alias, msg_type, body,
       is_pinned, is_deleted, edited_at, created_at
FROM messages FORCE INDEX (idx_messages_convo_cursor)
WHERE pod_id = @ve_pod_id
  AND dm_user_low_id = @ve_dm_low
  AND dm_user_high_id = @ve_dm_high
  AND id < @ve_dm_cursor_id
ORDER BY id DESC
LIMIT 40;

-- ============================================================================
-- QUERY 5: 1:1 DM conversation summary per peer (idx_messages_convo_cursor / idx_messages_dm_low + idx_messages_dm_high)
-- ============================================================================
SELECT '=== Q5: 1:1 DM conversation summary (idx_messages_convo_cursor + idx_messages_dm_high) ===' AS check_name;

EXPLAIN
SELECT pod_id, dm_user_high_id AS peer_user_id, MAX(id) AS last_message_id
FROM messages FORCE INDEX (idx_messages_convo_cursor)
WHERE pod_id = @ve_pod_id AND dm_user_low_id = @ve_peer_b_id
GROUP BY pod_id, dm_user_high_id
UNION ALL
SELECT pod_id, dm_user_low_id AS peer_user_id, MAX(id) AS last_message_id
FROM messages FORCE INDEX (idx_messages_dm_high)
WHERE pod_id = @ve_pod_id AND dm_user_high_id = @ve_peer_b_id AND dm_user_low_id > 0
GROUP BY pod_id, dm_user_low_id;

EXPLAIN ANALYZE
SELECT pod_id, dm_user_high_id AS peer_user_id, MAX(id) AS last_message_id
FROM messages FORCE INDEX (idx_messages_convo_cursor)
WHERE pod_id = @ve_pod_id AND dm_user_low_id = @ve_peer_b_id
GROUP BY pod_id, dm_user_high_id
UNION ALL
SELECT pod_id, dm_user_low_id AS peer_user_id, MAX(id) AS last_message_id
FROM messages FORCE INDEX (idx_messages_dm_high)
WHERE pod_id = @ve_pod_id AND dm_user_high_id = @ve_peer_b_id AND dm_user_low_id > 0
GROUP BY pod_id, dm_user_low_id;

-- ============================================================================
-- QUERY 6: Group Chat pinned messages (idx_messages_pod_pinned, zero filesort)
-- ============================================================================
SELECT '=== Q6: Group Chat pinned messages (idx_messages_pod_pinned) ===' AS check_name;

EXPLAIN
SELECT id, pod_id, sender_alias, sender_color, body, created_at
FROM messages FORCE INDEX (idx_messages_pod_pinned)
WHERE pod_id = @ve_pod_id
  AND dm_user_low_id = 0
  AND is_pinned = 1
  AND is_deleted = 0
ORDER BY id DESC
LIMIT 100;

EXPLAIN ANALYZE
SELECT id, pod_id, sender_alias, sender_color, body, created_at
FROM messages FORCE INDEX (idx_messages_pod_pinned)
WHERE pod_id = @ve_pod_id
  AND dm_user_low_id = 0
  AND is_pinned = 1
  AND is_deleted = 0
ORDER BY id DESC
LIMIT 100;

-- ============================================================================
-- QUERY 7: Publicized groups directory (idx_pods_publicized, zero filesort)
-- ============================================================================
SELECT '=== Q7: Publicized groups directory (idx_pods_publicized) ===' AS check_name;

EXPLAIN
SELECT p.id, p.public_id, p.code, p.title, p.member_count, p.max_members
FROM pods p FORCE INDEX (idx_pods_publicized)
WHERE p.is_publicized = 1
  AND p.interest_id = @ve_gaming_id
ORDER BY p.member_count DESC, p.id ASC
LIMIT 50;

EXPLAIN ANALYZE
SELECT p.id, p.public_id, p.code, p.title, p.member_count, p.max_members
FROM pods p FORCE INDEX (idx_pods_publicized)
WHERE p.is_publicized = 1
  AND p.interest_id = @ve_gaming_id
ORDER BY p.member_count DESC, p.id ASC
LIMIT 50;

-- ============================================================================
-- QUERY 8: Pod FULLTEXT search with DM confidentiality filter (ft_messages_body)
-- ============================================================================
SELECT '=== Q8: Pod FULLTEXT search with DM confidentiality (ft_messages_body) ===' AS check_name;

EXPLAIN
SELECT id, sender_alias, sender_color, body, created_at
FROM messages
WHERE pod_id = @ve_pod_id
  AND is_deleted = 0
  AND (dm_user_low_id = 0 OR dm_user_low_id = @ve_user_id OR dm_user_high_id = @ve_user_id)
  AND MATCH(body) AGAINST('+Helldivers*' IN BOOLEAN MODE)
LIMIT 50;

EXPLAIN ANALYZE
SELECT id, sender_alias, sender_color, body, created_at
FROM messages
WHERE pod_id = @ve_pod_id
  AND is_deleted = 0
  AND (dm_user_low_id = 0 OR dm_user_low_id = @ve_user_id OR dm_user_high_id = @ve_user_id)
  AND MATCH(body) AGAINST('+Helldivers*' IN BOOLEAN MODE)
LIMIT 50;

-- ============================================================================
-- CLEANUP: Remove all synthetic test rows so `canopy` ends clean
-- ============================================================================
DELETE FROM poll_votes WHERE poll_id = @ve_poll_id;
DELETE FROM polls WHERE id = @ve_poll_id;
DELETE FROM message_attachments WHERE storage_path = 've-voice.webm';
DELETE FROM user_bookmarks WHERE user_id >= @ve_user_id;
DELETE FROM message_reactions WHERE message_id = @ve_sample_msg_id;
DELETE FROM messages WHERE pod_id >= @ve_pod_id;
DELETE FROM pod_opt_outs WHERE user_id >= @ve_user_id;
DELETE FROM pod_members WHERE pod_id >= @ve_pod_id;
DELETE FROM pods WHERE code LIKE 've-pod-%';
DELETE FROM user_interests WHERE user_id >= @ve_user_id;
DELETE FROM users WHERE email LIKE 'verify-user-%@canopy.test';

ALTER TABLE users AUTO_INCREMENT = 1;
ALTER TABLE pods AUTO_INCREMENT = 1;
ALTER TABLE messages AUTO_INCREMENT = 1;
ALTER TABLE message_attachments AUTO_INCREMENT = 1;
ALTER TABLE polls AUTO_INCREMENT = 1;

ANALYZE TABLE
  users, interests, user_interests, pods, pod_members,
  pod_opt_outs, messages, message_reactions, user_bookmarks,
  message_attachments, polls, poll_votes, pod_invites, pod_proposals, pod_proposal_votes;

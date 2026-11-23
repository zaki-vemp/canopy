-- Verify EXPLAIN and EXPLAIN ANALYZE plans for all 5 hot Canopy OLTP queries.
-- Commits realistic multi-pod/Slack-thread rows so InnoDB flushes FULLTEXT
-- inverted indexes and statistics, runs EXPLAIN + EXPLAIN ANALYZE, then cleans
-- up all synthetic rows (leaving `canopy` with only the 12 seeded `interests`).

-- 1. Synthetic users (64 rows; private auth PII strictly isolated in `users`)
INSERT INTO users (public_id, email, password_hash, full_name, gender, nationality_code)
WITH RECURSIVE seq(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 64
)
SELECT UNHEX(CONCAT('0193456789abcdef7000', LPAD(HEX(n), 12, '0'))),
       CONCAT('verify-user-', n, '@canopy.test'),
       '$2a$10$7EqJtq98hPqEX7fNZaFWoOHi6M2W8r6Z9x0y1z2a3b4c5d6e7f8g9',
       CONCAT('Verify User ', n),
       ELT((n MOD 3) + 1, 'female', 'male', 'non-binary'),
       ELT((n MOD 4) + 1, 'IN', 'US', 'DE', 'JP')
FROM seq;

SET @ve_user_id := (
  SELECT id FROM users WHERE email = 'verify-user-1@canopy.test'
);
SET @ve_gaming_id := (SELECT id FROM interests WHERE slug = 'gaming');
SET @ve_chess_id  := (SELECT id FROM interests WHERE slug = 'chess');

INSERT INTO user_interests (user_id, interest_id)
VALUES
  (@ve_user_id, @ve_gaming_id),
  (@ve_user_id, @ve_chess_id);

-- 2. Synthetic pods (48 rows: 4 per seeded interest; 3 open, 1 full/closed)
INSERT INTO pods (public_id, interest_id, code, member_count, max_members, is_open)
SELECT UNHEX(CONCAT('0193456789abcdef8000', LPAD(HEX(ROW_NUMBER() OVER (ORDER BY i.id, k.n)), 12, '0'))),
       i.id,
       CONCAT('ve-pod-', 9000 + ROW_NUMBER() OVER (ORDER BY i.id, k.n)),
       IF(k.n = 4, 6, k.n),
       6,
       IF(k.n = 4, 0, 1)
FROM interests i
CROSS JOIN (
  SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
) k;

SET @ve_pod_id := (
  SELECT MIN(id) FROM pods
  WHERE code LIKE 've-pod-%' AND interest_id = @ve_gaming_id AND is_open = 1
);
SET @ve_opted_out_pod_id := (
  SELECT MIN(id) FROM pods
  WHERE code LIKE 've-pod-%' AND interest_id = @ve_gaming_id AND is_open = 1 AND id > @ve_pod_id
);

-- 3. Channels per synthetic pod (general text + lounge voice)
INSERT INTO pod_channels (public_id, pod_id, slug, label, topic, kind, position)
SELECT UNHEX(CONCAT('0193456789abcdef9000', LPAD(HEX(ROW_NUMBER() OVER (ORDER BY p.id, c.pos)), 12, '0'))),
       p.id,
       c.slug,
       c.label,
       c.topic,
       c.kind,
       c.pos
FROM pods p
CROSS JOIN (
  SELECT 'general' AS slug, 'general' AS label, 'Main group chat' AS topic, 1 AS kind, 0 AS pos
  UNION ALL
  SELECT 'lounge-voice', 'Lounge Voice', 'Drop-in voice', 2, 1
) c
WHERE p.code LIKE 've-pod-%';

SET @ve_channel_id := (
  SELECT id FROM pod_channels WHERE pod_id = @ve_pod_id AND slug = 'general'
);

-- 4. Peer-blind pod members + opt-out row for anti-join verification
INSERT INTO pod_members (pod_id, user_id, alias, alias_color, custom_status)
SELECT p.id,
       @ve_user_id + 1 + (ROW_NUMBER() OVER (ORDER BY p.id) MOD 50),
       ELT((p.id MOD 4) + 1, 'Cobalt Fox', 'Amber Heron', 'Slate Otter', 'Mint Owl'),
       '#1f6b3a',
       'Ready for co-op'
FROM pods p
WHERE p.code LIKE 've-pod-%';

INSERT INTO pod_members (pod_id, user_id, alias, alias_color, custom_status)
VALUES (@ve_pod_id, @ve_user_id, 'Cobalt Fox', '#1f6b3a', 'Hosting lobby');

INSERT INTO pod_opt_outs (user_id, pod_id)
VALUES (@ve_user_id, @ve_opted_out_pod_id);

-- 5. Realistic interleaved Slack-style messages across 8 general channels
--    (2,400 rows: 75 top-level + 225 thread replies per channel)
INSERT INTO messages (
  pod_id, channel_id, sender_user_id, sender_alias, sender_color,
  parent_message_id, msg_type, body, is_pinned
)
WITH RECURSIVE a(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM a WHERE n < 300
),
b(m) AS (
  SELECT 0 UNION ALL SELECT m + 1 FROM b WHERE m < 7
)
SELECT @ve_pod_id + m,
       @ve_channel_id + (m * 2),
       @ve_user_id + ((n + m) MOD 16),
       ELT(((n + m) MOD 4) + 1, 'Cobalt Fox', 'Amber Heron', 'Slate Otter', 'Mint Owl'),
       '#1f6b3a',
       IF(n MOD 4 = 0, 0, 1 + (n MOD 24)),
       1,
       IF(
         n MOD 25 = 0,
         CONCAT('Anyone up for co-op (cooperative) raid session tonight? Lobby #', n),
         CONCAT('Evening pod check-in message #', n, ' discussing strategy builds')
       ),
       IF(n = 100 AND m = 0, 1, 0)
FROM a CROSS JOIN b
ORDER BY n, m;

SET @ve_parent_msg_id := (
  SELECT MIN(id) FROM messages
  WHERE channel_id = @ve_channel_id AND parent_message_id = 0
);

-- Dedicated 12-reply Slack thread anchored on @ve_parent_msg_id
INSERT INTO messages (
  pod_id, channel_id, sender_user_id, sender_alias, sender_color,
  parent_message_id, msg_type, body
)
WITH RECURSIVE rseq(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM rseq WHERE n < 12
)
SELECT @ve_pod_id,
       @ve_channel_id,
       @ve_user_id + (n MOD 4),
       ELT((n MOD 4) + 1, 'Cobalt Fox', 'Amber Heron', 'Slate Otter', 'Mint Owl'),
       '#1f6b3a',
       @ve_parent_msg_id,
       1,
       CONCAT('Thread reply #', n, ' confirming co-op loadout')
FROM rseq;

UPDATE messages SET reply_count = 12 WHERE id = @ve_parent_msg_id;

-- Page-2 cursor: 25 top-level messages down from the newest message in @ve_channel_id
SET @ve_cursor_id := (
  SELECT id FROM (
    SELECT id FROM messages
    WHERE channel_id = @ve_channel_id AND parent_message_id = 0
    ORDER BY id DESC
    LIMIT 1 OFFSET 25
  ) AS cur
);

-- 6. Sample reactions, bookmarks, attachments, polls & votes
INSERT INTO message_reactions (message_id, emoji, user_id, reactor_alias)
VALUES (@ve_parent_msg_id, '🔥', @ve_user_id, 'Cobalt Fox');

INSERT INTO user_bookmarks (user_id, message_id, pod_id)
VALUES (@ve_user_id, @ve_parent_msg_id, @ve_pod_id);

INSERT INTO message_attachments (
  message_id, pod_id, uploader_user_id, kind, file_name, mime_type, size_bytes, duration_ms, storage_path
) VALUES (
  @ve_parent_msg_id, @ve_pod_id, @ve_user_id, 'voice_note', 'voice.webm', 'audio/webm', 18240, 4200, 've-voice.webm'
);

INSERT INTO polls (message_id, question, options_json)
VALUES (@ve_parent_msg_id, 'What co-op game tonight?', JSON_ARRAY('Helldivers', 'Deep Rock'));

SET @ve_poll_id := LAST_INSERT_ID();

INSERT INTO poll_votes (poll_id, user_id, option_index, voter_alias)
VALUES (@ve_poll_id, @ve_user_id, 0, 'Cobalt Fox');

-- Refresh optimizer statistics & FULLTEXT index stats before measuring
ANALYZE TABLE
  users, interests, user_interests, pods, pod_channels, pod_members,
  pod_opt_outs, messages, message_reactions, user_bookmarks,
  message_attachments, polls, poll_votes;

-- ============================================================================
-- QUERY 1: Auth login lookup (WHERE email = ? -> idx_users_email)
-- ============================================================================
SELECT '=== Q1: Auth login lookup (WHERE email = ? -> idx_users_email) ===' AS check_name;

EXPLAIN
SELECT id, public_id, email, password_hash, full_name, gender, nationality_code
FROM users
WHERE email = 'verify-user-1@canopy.test';

EXPLAIN ANALYZE
SELECT id, public_id, email, password_hash, full_name, gender, nationality_code
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
  AND p.member_count < p.max_members
  AND poo.pod_id IS NULL
LIMIT 5;

-- ============================================================================
-- QUERY 3: Channel cursor pagination (idx_messages_channel_cursor, zero filesort)
-- ============================================================================
SELECT '=== Q3: Channel cursor pagination (idx_messages_channel_cursor) ===' AS check_name;

EXPLAIN
SELECT id, pod_id, channel_id, sender_alias, sender_color, msg_type, body,
       reply_count, is_pinned, is_deleted, edited_at, created_at
FROM messages
WHERE channel_id = @ve_channel_id
  AND parent_message_id = 0
  AND id < @ve_cursor_id
ORDER BY id DESC
LIMIT 40;

EXPLAIN ANALYZE
SELECT id, pod_id, channel_id, sender_alias, sender_color, msg_type, body,
       reply_count, is_pinned, is_deleted, edited_at, created_at
FROM messages
WHERE channel_id = @ve_channel_id
  AND parent_message_id = 0
  AND id < @ve_cursor_id
ORDER BY id DESC
LIMIT 40;

-- ============================================================================
-- QUERY 4: Slack thread drawer query (idx_messages_thread_cursor)
-- ============================================================================
SELECT '=== Q4: Slack thread drawer query (idx_messages_thread_cursor) ===' AS check_name;

EXPLAIN
SELECT id, pod_id, channel_id, sender_alias, sender_color, msg_type, body,
       is_deleted, edited_at, created_at
FROM messages
WHERE parent_message_id = @ve_parent_msg_id
ORDER BY id ASC;

EXPLAIN ANALYZE
SELECT id, pod_id, channel_id, sender_alias, sender_color, msg_type, body,
       is_deleted, edited_at, created_at
FROM messages
WHERE parent_message_id = @ve_parent_msg_id
ORDER BY id ASC;

-- ============================================================================
-- QUERY 5: Boolean FULLTEXT search (ft_messages_body)
-- ============================================================================
SELECT '=== Q5: Boolean FULLTEXT search (ft_messages_body) ===' AS check_name;

EXPLAIN
SELECT id, channel_id, sender_alias, sender_color, body, created_at
FROM messages
WHERE pod_id = @ve_pod_id
  AND MATCH(body) AGAINST('+co-op*' IN BOOLEAN MODE)
LIMIT 20;

EXPLAIN ANALYZE
SELECT id, channel_id, sender_alias, sender_color, body, created_at
FROM messages
WHERE pod_id = @ve_pod_id
  AND MATCH(body) AGAINST('+co-op*' IN BOOLEAN MODE)
LIMIT 20;

-- ============================================================================
-- CLEANUP: Remove all synthetic test rows so `canopy` ends clean
-- ============================================================================
DELETE FROM poll_votes WHERE poll_id = @ve_poll_id;
DELETE FROM polls WHERE id = @ve_poll_id;
DELETE FROM message_attachments WHERE storage_path = 've-voice.webm';
DELETE FROM user_bookmarks WHERE user_id >= @ve_user_id;
DELETE FROM message_reactions WHERE message_id = @ve_parent_msg_id;
DELETE FROM messages WHERE pod_id >= @ve_pod_id;
DELETE FROM pod_opt_outs WHERE user_id >= @ve_user_id;
DELETE FROM pod_members WHERE pod_id >= @ve_pod_id;
DELETE FROM pod_channels WHERE pod_id >= @ve_pod_id;
DELETE FROM pods WHERE code LIKE 've-pod-%';
DELETE FROM user_interests WHERE user_id >= @ve_user_id;
DELETE FROM users WHERE email LIKE 'verify-user-%@canopy.test';

ALTER TABLE users AUTO_INCREMENT = 1;
ALTER TABLE pods AUTO_INCREMENT = 1;
ALTER TABLE pod_channels AUTO_INCREMENT = 1;
ALTER TABLE messages AUTO_INCREMENT = 1;
ALTER TABLE message_attachments AUTO_INCREMENT = 1;
ALTER TABLE polls AUTO_INCREMENT = 1;

ANALYZE TABLE
  users, interests, user_interests, pods, pod_channels, pod_members,
  pod_opt_outs, messages, message_reactions, user_bookmarks,
  message_attachments, polls, poll_votes;

-- One time, TiDB only: rebuild the tables that are read in id order so their ids
-- come from one counter (AUTO_ID_CACHE 1). The option can only be set when a table
-- is created. New databases do not need this: DatabaseInitializer sets it.
--
-- Stop the backend first, so nothing is written while rows are copied.
-- The old tables stay as <name>_before_rebuild. Running this twice loses nothing:
-- the RENAME stops because those names are taken.
-- New ids start at 1000000, above every id handed out so far. Part 1 checks that.

-- Part 1: every row must say ok. Otherwise stop here.
SELECT 'messages' AS tbl, COUNT(*) AS row_count, COALESCE(MAX(id), 0) AS max_id, IF(COALESCE(MAX(id), 0) < 1000000, 'ok', 'STOP') AS verdict FROM messages
UNION ALL
SELECT 'message_attachments' AS tbl, COUNT(*) AS row_count, COALESCE(MAX(id), 0) AS max_id, IF(COALESCE(MAX(id), 0) < 1000000, 'ok', 'STOP') AS verdict FROM message_attachments
UNION ALL
SELECT 'pod_invites' AS tbl, COUNT(*) AS row_count, COALESCE(MAX(id), 0) AS max_id, IF(COALESCE(MAX(id), 0) < 1000000, 'ok', 'STOP') AS verdict FROM pod_invites
UNION ALL
SELECT 'pod_proposals' AS tbl, COUNT(*) AS row_count, COALESCE(MAX(id), 0) AS max_id, IF(COALESCE(MAX(id), 0) < 1000000, 'ok', 'STOP') AS verdict FROM pod_proposals;

-- Part 2: build and fill the new tables.

CREATE TABLE messages_rebuilt (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  pod_id BIGINT UNSIGNED NOT NULL,
  sender_user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  sender_alias VARCHAR(32) NOT NULL,
  sender_color VARCHAR(16) NOT NULL DEFAULT '#232323',
  recipient_user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  recipient_alias VARCHAR(32) NOT NULL DEFAULT '',
  dm_user_low_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  dm_user_high_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  quote_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  msg_type TINYINT UNSIGNED NOT NULL DEFAULT 1,
  body VARCHAR(4000) NOT NULL DEFAULT '',
  is_pinned TINYINT UNSIGNED NOT NULL DEFAULT 0,
  is_deleted TINYINT UNSIGNED NOT NULL DEFAULT 0,
  edited_at DATETIME NULL DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_messages_convo_cursor (pod_id, dm_user_low_id, dm_user_high_id, id DESC),
  KEY idx_messages_dm_low (pod_id, dm_user_low_id, id DESC),
  KEY idx_messages_dm_high (pod_id, dm_user_high_id, id DESC),
  KEY idx_messages_pod_pinned (pod_id, dm_user_low_id, is_pinned, id DESC)
) ENGINE=InnoDB AUTO_ID_CACHE=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO messages_rebuilt (id, pod_id, sender_user_id, sender_alias, sender_color, recipient_user_id, recipient_alias, dm_user_low_id, dm_user_high_id, quote_message_id, msg_type, body, is_pinned, is_deleted, edited_at, created_at)
SELECT id, pod_id, sender_user_id, sender_alias, sender_color, recipient_user_id, recipient_alias, dm_user_low_id, dm_user_high_id, quote_message_id, msg_type, body, is_pinned, is_deleted, edited_at, created_at FROM messages;

ALTER TABLE messages_rebuilt AUTO_INCREMENT = 1000000;

CREATE TABLE message_attachments_rebuilt (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  pod_id BIGINT UNSIGNED NOT NULL,
  uploader_user_id BIGINT UNSIGNED NOT NULL,
  kind VARCHAR(16) NOT NULL,
  file_name VARCHAR(180) NOT NULL,
  mime_type VARCHAR(80) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
  storage_path VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_attachments_message (message_id)
) ENGINE=InnoDB AUTO_ID_CACHE=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO message_attachments_rebuilt (id, message_id, pod_id, uploader_user_id, kind, file_name, mime_type, size_bytes, duration_ms, storage_path, created_at)
SELECT id, message_id, pod_id, uploader_user_id, kind, file_name, mime_type, size_bytes, duration_ms, storage_path, created_at FROM message_attachments;

ALTER TABLE message_attachments_rebuilt AUTO_INCREMENT = 1000000;

CREATE TABLE pod_invites_rebuilt (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  pod_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(24) NOT NULL,
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  created_by_alias VARCHAR(32) NOT NULL,
  max_uses INT UNSIGNED NOT NULL DEFAULT 0,
  uses_count INT UNSIGNED NOT NULL DEFAULT 0,
  is_revoked TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME NULL DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY idx_pod_invites_code (code),
  KEY idx_pod_invites_pod_active (pod_id, is_revoked, id DESC)
) ENGINE=InnoDB AUTO_ID_CACHE=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO pod_invites_rebuilt (id, pod_id, code, created_by_user_id, created_by_alias, max_uses, uses_count, is_revoked, expires_at, created_at)
SELECT id, pod_id, code, created_by_user_id, created_by_alias, max_uses, uses_count, is_revoked, expires_at, created_at FROM pod_invites;

ALTER TABLE pod_invites_rebuilt AUTO_INCREMENT = 1000000;

CREATE TABLE pod_proposals_rebuilt (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  pod_id BIGINT UNSIGNED NOT NULL,
  proposer_user_id BIGINT UNSIGNED NOT NULL,
  proposer_alias VARCHAR(32) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  title VARCHAR(180) NOT NULL,
  payload_json JSON NOT NULL,
  target_user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  target_alias VARCHAR(32) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  yes_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  no_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  eligible_count SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  announcement_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  resolved_at DATETIME NULL DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_proposals_pod_status (pod_id, status, id DESC),
  KEY idx_proposals_open_exp (status, expires_at)
) ENGINE=InnoDB AUTO_ID_CACHE=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO pod_proposals_rebuilt (id, pod_id, proposer_user_id, proposer_alias, kind, title, payload_json, target_user_id, target_alias, status, yes_count, no_count, eligible_count, announcement_message_id, expires_at, resolved_at, created_at)
SELECT id, pod_id, proposer_user_id, proposer_alias, kind, title, payload_json, target_user_id, target_alias, status, yes_count, no_count, eligible_count, announcement_message_id, expires_at, resolved_at, created_at FROM pod_proposals;

ALTER TABLE pod_proposals_rebuilt AUTO_INCREMENT = 1000000;

-- Part 3: both counts and both sums must match in every row. Otherwise stop here.
SELECT 'messages' AS tbl, (SELECT COUNT(*) FROM messages) AS old_rows, (SELECT COUNT(*) FROM messages_rebuilt) AS new_rows, (SELECT COALESCE(SUM(id), 0) FROM messages) AS old_sum, (SELECT COALESCE(SUM(id), 0) FROM messages_rebuilt) AS new_sum
UNION ALL
SELECT 'message_attachments' AS tbl, (SELECT COUNT(*) FROM message_attachments) AS old_rows, (SELECT COUNT(*) FROM message_attachments_rebuilt) AS new_rows, (SELECT COALESCE(SUM(id), 0) FROM message_attachments) AS old_sum, (SELECT COALESCE(SUM(id), 0) FROM message_attachments_rebuilt) AS new_sum
UNION ALL
SELECT 'pod_invites' AS tbl, (SELECT COUNT(*) FROM pod_invites) AS old_rows, (SELECT COUNT(*) FROM pod_invites_rebuilt) AS new_rows, (SELECT COALESCE(SUM(id), 0) FROM pod_invites) AS old_sum, (SELECT COALESCE(SUM(id), 0) FROM pod_invites_rebuilt) AS new_sum
UNION ALL
SELECT 'pod_proposals' AS tbl, (SELECT COUNT(*) FROM pod_proposals) AS old_rows, (SELECT COUNT(*) FROM pod_proposals_rebuilt) AS new_rows, (SELECT COALESCE(SUM(id), 0) FROM pod_proposals) AS old_sum, (SELECT COALESCE(SUM(id), 0) FROM pod_proposals_rebuilt) AS new_sum;

-- Part 4: swap. Undo by renaming back.
RENAME TABLE
  messages TO messages_before_rebuild,
  messages_rebuilt TO messages,
  message_attachments TO message_attachments_before_rebuild,
  message_attachments_rebuilt TO message_attachments,
  pod_invites TO pod_invites_before_rebuild,
  pod_invites_rebuilt TO pod_invites,
  pod_proposals TO pod_proposals_before_rebuild,
  pod_proposals_rebuilt TO pod_proposals;

package com.canopy.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.support.EncodedResource;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

@Component
public class DatabaseInitializer implements ApplicationRunner {
    private static final Logger log = LoggerFactory.getLogger(DatabaseInitializer.class);

    private static final String FALLBACK_DDL = """
        CREATE TABLE IF NOT EXISTS users (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          public_id BINARY(16) NOT NULL,
          email VARCHAR(190) NOT NULL,
          password_hash VARCHAR(100) NOT NULL,
          full_name VARCHAR(100) NOT NULL DEFAULT '',
          gender VARCHAR(32) NOT NULL DEFAULT '',
          nationality_code CHAR(2) NOT NULL DEFAULT '',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          plan_tier VARCHAR(16) NOT NULL DEFAULT 'FREE',
          UNIQUE KEY idx_users_public_id (public_id),
          UNIQUE KEY idx_users_email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS interests (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          slug VARCHAR(64) NOT NULL,
          label VARCHAR(64) NOT NULL,
          category VARCHAR(32) NOT NULL DEFAULT 'general',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY idx_interests_slug (slug)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS user_interests (
          user_id BIGINT UNSIGNED NOT NULL,
          interest_id BIGINT UNSIGNED NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, interest_id),
          KEY idx_user_interests_interest (interest_id, user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS pods (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          public_id BINARY(16) NOT NULL,
          interest_id BIGINT UNSIGNED NOT NULL,
          code VARCHAR(32) NOT NULL,
          member_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
          max_members TINYINT UNSIGNED NOT NULL DEFAULT 25,
          is_open TINYINT UNSIGNED NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          title VARCHAR(80) NOT NULL DEFAULT '',
          description VARCHAR(280) NOT NULL DEFAULT '',
          governance_mode VARCHAR(16) NOT NULL DEFAULT 'DEMOCRATIC',
          owner_user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
          is_publicized TINYINT UNSIGNED NOT NULL DEFAULT 0,
          allow_random_match TINYINT UNSIGNED NOT NULL DEFAULT 1,
          UNIQUE KEY idx_pods_public_id (public_id),
          KEY idx_pods_match (interest_id, is_open, member_count, id),
          KEY idx_pods_publicized (is_publicized, interest_id, member_count, id DESC)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS pod_channels (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          public_id BINARY(16) NOT NULL,
          pod_id BIGINT UNSIGNED NOT NULL,
          slug VARCHAR(48) NOT NULL,
          label VARCHAR(64) NOT NULL,
          topic VARCHAR(160) NOT NULL DEFAULT '',
          kind TINYINT UNSIGNED NOT NULL DEFAULT 1,
          position TINYINT UNSIGNED NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY idx_pod_channels_public_id (public_id),
          UNIQUE KEY idx_pod_channels_pod_slug (pod_id, slug),
          KEY idx_pod_channels_pod_pos (pod_id, kind, position)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS pod_members (
          pod_id BIGINT UNSIGNED NOT NULL,
          user_id BIGINT UNSIGNED NOT NULL,
          alias VARCHAR(32) NOT NULL,
          alias_color VARCHAR(16) NOT NULL,
          custom_status VARCHAR(80) NOT NULL DEFAULT '',
          voice_channel_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
          joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          role VARCHAR(12) NOT NULL DEFAULT 'MEMBER',
          PRIMARY KEY (pod_id, user_id),
          KEY idx_pod_members_user (user_id, pod_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS pod_opt_outs (
          user_id BIGINT UNSIGNED NOT NULL,
          pod_id BIGINT UNSIGNED NOT NULL,
          left_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, pod_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS messages (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          pod_id BIGINT UNSIGNED NOT NULL,
          channel_id BIGINT UNSIGNED NOT NULL,
          sender_user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
          sender_alias VARCHAR(32) NOT NULL,
          sender_color VARCHAR(16) NOT NULL DEFAULT '#232323',
          parent_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
          quote_message_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
          msg_type TINYINT UNSIGNED NOT NULL DEFAULT 1,
          body VARCHAR(4000) NOT NULL DEFAULT '',
          reply_count INT UNSIGNED NOT NULL DEFAULT 0,
          is_pinned TINYINT UNSIGNED NOT NULL DEFAULT 0,
          is_deleted TINYINT UNSIGNED NOT NULL DEFAULT 0,
          edited_at DATETIME NULL DEFAULT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_messages_channel_cursor (channel_id, parent_message_id, id DESC),
          KEY idx_messages_thread_cursor (parent_message_id, id ASC),
          KEY idx_messages_channel_pinned (channel_id, is_pinned, id DESC),
          KEY idx_messages_pod_pinned (pod_id, is_pinned, id DESC),
          FULLTEXT KEY ft_messages_body (body)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS message_reactions (
          message_id BIGINT UNSIGNED NOT NULL,
          emoji VARCHAR(32) NOT NULL,
          user_id BIGINT UNSIGNED NOT NULL,
          reactor_alias VARCHAR(32) NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (message_id, emoji, user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS user_bookmarks (
          user_id BIGINT UNSIGNED NOT NULL,
          message_id BIGINT UNSIGNED NOT NULL,
          pod_id BIGINT UNSIGNED NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, message_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS message_attachments (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS polls (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          message_id BIGINT UNSIGNED NOT NULL,
          question VARCHAR(240) NOT NULL,
          options_json JSON NOT NULL,
          is_closed TINYINT UNSIGNED NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY idx_polls_message (message_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS poll_votes (
          poll_id BIGINT UNSIGNED NOT NULL,
          user_id BIGINT UNSIGNED NOT NULL,
          option_index TINYINT UNSIGNED NOT NULL,
          voter_alias VARCHAR(32) NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (poll_id, user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS pod_invites (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS pod_proposals (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

        CREATE TABLE IF NOT EXISTS pod_proposal_votes (
          proposal_id BIGINT UNSIGNED NOT NULL,
          user_id BIGINT UNSIGNED NOT NULL,
          voter_alias VARCHAR(32) NOT NULL,
          vote TINYINT UNSIGNED NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (proposal_id, user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
        """;

    private static final String FALLBACK_SEED = """
        INSERT INTO interests (slug, label, category)
        VALUES
          ('gaming', 'Gaming', 'play'),
          ('music-production', 'Music Production', 'creative'),
          ('late-night-coding', 'Late-Night Coding', 'tech'),
          ('chess', 'Chess', 'play'),
          ('sci-fi-cinema', 'Sci-Fi & Cinema', 'culture'),
          ('fitness', 'Strength & Running', 'health'),
          ('cooking', 'Home Cooking', 'lifestyle'),
          ('indie-books', 'Indie Books', 'culture'),
          ('board-games', 'Tabletop & Strategy', 'play'),
          ('language-practice', 'Spoken Languages', 'social'),
          ('electronic-art', 'Synth & Visual Art', 'creative'),
          ('philosophy', 'Open Philosophy', 'social')
        AS seeded
        ON DUPLICATE KEY UPDATE
          label = seeded.label,
          category = seeded.category;
        """;

    private final JdbcTemplate jdbcTemplate;

    public DatabaseInitializer(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Override
    public void run(ApplicationArguments args) {
        // ponytail: single-node startup DDL & seed runner; use PlanetScale deploy requests in multi-replica production
        String ddl = readFirstExisting(List.of(
            Path.of("../db/migrations/001_init.sql"),
            Path.of("db/migrations/001_init.sql")
        ));
        if (ddl != null && ddl.contains("pod_proposals")) {
            executeSql(ddl);
        } else {
            executeSql(FALLBACK_DDL);
        }
        ensureSchemaUpgrades();

        String seed = readFirstExisting(List.of(
            Path.of("../db/seed.sql"),
            Path.of("db/seed.sql")
        ));
        executeSql(seed != null ? seed : FALLBACK_SEED);
        log.info("Database schema and default interests verified");
    }

    private void ensureSchemaUpgrades() {
        ensureColumn("users", "plan_tier", "VARCHAR(16) NOT NULL DEFAULT 'FREE'");
        ensureColumn("pods", "title", "VARCHAR(80) NOT NULL DEFAULT ''");
        ensureColumn("pods", "description", "VARCHAR(280) NOT NULL DEFAULT ''");
        ensureColumn("pods", "governance_mode", "VARCHAR(16) NOT NULL DEFAULT 'DEMOCRATIC'");
        ensureColumn("pods", "owner_user_id", "BIGINT UNSIGNED NOT NULL DEFAULT 0");
        ensureColumn("pods", "is_publicized", "TINYINT UNSIGNED NOT NULL DEFAULT 0");
        ensureColumn("pods", "allow_random_match", "TINYINT UNSIGNED NOT NULL DEFAULT 1");
        ensureColumn("pod_members", "role", "VARCHAR(12) NOT NULL DEFAULT 'MEMBER'");
        ensureIndex(
            "pods",
            "idx_pods_publicized",
            "CREATE INDEX idx_pods_publicized ON pods (is_publicized, interest_id, member_count, id DESC)"
        );
    }

    private void ensureColumn(String table, String column, String definition) {
        Integer count = jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
            Integer.class,
            table,
            column
        );
        if (count != null && count == 0) {
            jdbcTemplate.execute("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition);
        }
    }

    private void ensureIndex(String table, String indexName, String createIndexSql) {
        Integer count = jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?",
            Integer.class,
            table,
            indexName
        );
        if (count != null && count == 0) {
            jdbcTemplate.execute(createIndexSql);
        }
    }

    private String readFirstExisting(List<Path> candidates) {
        for (Path path : candidates) {
            if (Files.isRegularFile(path)) {
                try {
                    return Files.readString(path, StandardCharsets.UTF_8);
                } catch (IOException e) {
                    log.warn("Failed reading SQL script {}: {}", path, e.getMessage());
                }
            }
        }
        return null;
    }

    private void executeSql(String sql) {
        EncodedResource resource = new EncodedResource(
            new ByteArrayResource(sql.getBytes(StandardCharsets.UTF_8)),
            StandardCharsets.UTF_8
        );
        jdbcTemplate.execute((ConnectionCallback<Void>) conn -> {
            ScriptUtils.executeSqlScript(conn, resource);
            return null;
        });
    }
}

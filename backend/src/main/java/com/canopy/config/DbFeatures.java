package com.canopy.config;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** What the connected database can do. TiDB speaks MySQL but has no MATCH ... AGAINST. */
@Component
public class DbFeatures {
    private final JdbcTemplate jdbcTemplate;
    private volatile Boolean fullText;

    public DbFeatures(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    // Asked on first use, not at construction: the Docker build starts the app without a database.
    public boolean fullText() {
        Boolean known = fullText;
        if (known == null) {
            String version = jdbcTemplate.queryForObject("SELECT VERSION()", String.class);
            known = version == null || !version.contains("TiDB");
            fullText = known;
        }
        return known;
    }
}

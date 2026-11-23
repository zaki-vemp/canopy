package com.canopy.auth;

import com.canopy.util.UuidV7;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.util.Objects;
import java.util.Optional;

@Repository
public class UserRepository {

    public record UserRow(
        long id,
        byte[] publicId,
        String email,
        String passwordHash,
        String fullName,
        String gender,
        String nationalityCode,
        String planTier
    ) {
        public AuthDtos.UserDto toDto() {
            return new AuthDtos.UserDto(
                UuidV7.toHex(publicId),
                email,
                fullName,
                gender,
                nationalityCode,
                planTier != null && !planTier.isBlank() ? planTier : "FREE"
            );
        }
    }

    private static final RowMapper<UserRow> USER_MAPPER = (rs, rowNum) -> {
        String rawPlan = rs.getString("plan_tier");
        return new UserRow(
            rs.getLong("id"),
            rs.getBytes("public_id"),
            rs.getString("email"),
            rs.getString("password_hash"),
            rs.getString("full_name"),
            rs.getString("gender"),
            rs.getString("nationality_code"),
            rawPlan != null && !rawPlan.isBlank() ? rawPlan : "FREE"
        );
    };

    private final JdbcClient jdbc;

    public UserRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Optional<UserRow> findByEmail(String email) {
        return jdbc.sql("""
                SELECT id, public_id, email, password_hash, full_name, gender, nationality_code, plan_tier
                FROM users
                WHERE email = :email
                """)
            .param("email", email)
            .query(USER_MAPPER)
            .optional();
    }

    public Optional<UserRow> findById(long id) {
        return jdbc.sql("""
                SELECT id, public_id, email, password_hash, full_name, gender, nationality_code, plan_tier
                FROM users
                WHERE id = :id
                """)
            .param("id", id)
            .query(USER_MAPPER)
            .optional();
    }

    public UserRow insert(
        byte[] publicId,
        String email,
        String passwordHash,
        String fullName,
        String gender,
        String nationalityCode
    ) {
        KeyHolder keyHolder = new GeneratedKeyHolder();
        jdbc.sql("""
                INSERT INTO users (public_id, email, password_hash, full_name, gender, nationality_code, plan_tier)
                VALUES (:publicId, :email, :passwordHash, :fullName, :gender, :nationalityCode, 'FREE')
                """)
            .param("publicId", publicId)
            .param("email", email)
            .param("passwordHash", passwordHash)
            .param("fullName", fullName)
            .param("gender", gender)
            .param("nationalityCode", nationalityCode)
            .update(keyHolder);
        long id = Objects.requireNonNull(keyHolder.getKey(), "Missing generated user ID").longValue();
        return new UserRow(id, publicId, email, passwordHash, fullName, gender, nationalityCode, "FREE");
    }

    public void updateProfile(long id, String fullName, String gender, String nationalityCode) {
        jdbc.sql("""
                UPDATE users
                SET full_name = :fullName,
                    gender = :gender,
                    nationality_code = :nationalityCode,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = :id
                """)
            .param("fullName", fullName)
            .param("gender", gender)
            .param("nationalityCode", nationalityCode)
            .param("id", id)
            .update();
    }

    public void updatePlanTier(long id, String planTier) {
        jdbc.sql("""
                UPDATE users
                SET plan_tier = :planTier,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = :id
                """)
            .param("planTier", planTier)
            .param("id", id)
            .update();
    }
}

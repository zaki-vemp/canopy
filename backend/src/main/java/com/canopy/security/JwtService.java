package com.canopy.security;

import com.canopy.util.UuidV7;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;

@Service
public class JwtService {
    private final SecretKey key;
    private final long expirationSeconds;

    public JwtService(
        @Value("${canopy.jwt.secret}") String secret,
        @Value("${canopy.jwt.expiration-seconds:604800}") long expirationSeconds
    ) {
        byte[] bytes = secret.getBytes(StandardCharsets.UTF_8);
        if (bytes.length < 32) {
            byte[] padded = new byte[32];
            System.arraycopy(bytes, 0, padded, 0, bytes.length);
            bytes = padded;
        }
        this.key = Keys.hmacShaKeyFor(bytes);
        this.expirationSeconds = expirationSeconds;
    }

    public String createToken(long userId, byte[] userPublicId, String email) {
        String pubHex = UuidV7.toHex(userPublicId);
        Instant now = Instant.now();
        return Jwts.builder()
            .subject(pubHex)
            .claim("uid", userId)
            .claim("email", email)
            .issuedAt(Date.from(now))
            .expiration(Date.from(now.plusSeconds(expirationSeconds)))
            .signWith(key)
            .compact();
    }

    public AuthPrincipal parseToken(String token) {
        Claims claims = Jwts.parser()
            .verifyWith(key)
            .build()
            .parseSignedClaims(token)
            .getPayload();
        String pubHex = claims.getSubject();
        Number uid = claims.get("uid", Number.class);
        String email = claims.get("email", String.class);
        if (pubHex == null || uid == null) {
            throw new IllegalArgumentException("Invalid token claims");
        }
        return new AuthPrincipal(uid.longValue(), UuidV7.fromHex(pubHex), pubHex, email != null ? email : "");
    }

    public long getExpirationSeconds() {
        return expirationSeconds;
    }
}

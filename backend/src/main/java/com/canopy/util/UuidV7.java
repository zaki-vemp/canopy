package com.canopy.util;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.HexFormat;

/**
 * Time-ordered UUIDv7 (BINARY(16)) + room-scoped peerId helper per PlanetScale primary-keys.md.
 */
public final class UuidV7 {
    private static final SecureRandom RNG = new SecureRandom();
    private static final HexFormat HEX = HexFormat.of();

    private UuidV7() {}

    public static byte[] generate() {
        byte[] out = new byte[16];
        RNG.nextBytes(out);
        long ms = System.currentTimeMillis();
        out[0] = (byte) (ms >>> 40);
        out[1] = (byte) (ms >>> 32);
        out[2] = (byte) (ms >>> 24);
        out[3] = (byte) (ms >>> 16);
        out[4] = (byte) (ms >>> 8);
        out[5] = (byte) ms;
        out[6] = (byte) ((out[6] & 0x0F) | 0x70); // version 7
        out[8] = (byte) ((out[8] & 0x3F) | 0x80); // RFC 4122 variant
        return out;
    }

    public static String toHex(byte[] bytes) {
        return HEX.formatHex(bytes);
    }

    public static byte[] fromHex(String id) {
        if (id == null) {
            throw new IllegalArgumentException("Missing ID");
        }
        String clean = id.replace("-", "").trim().toLowerCase();
        if (clean.length() != 32) {
            throw new IllegalArgumentException("Expected 32-char hex ID");
        }
        return HEX.parseHex(clean);
    }

    public static String peerId(byte[] podPublicId, byte[] userPublicId) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(podPublicId);
            md.update(userPublicId);
            byte[] digest = md.digest();
            return "p_" + HEX.formatHex(digest, 0, 6);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}

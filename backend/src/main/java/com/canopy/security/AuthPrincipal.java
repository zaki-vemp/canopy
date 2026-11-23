package com.canopy.security;

public record AuthPrincipal(
    long userId,
    byte[] userPublicId,
    String userPublicIdHex,
    String email
) {}

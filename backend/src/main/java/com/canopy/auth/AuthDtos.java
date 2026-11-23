package com.canopy.auth;

public final class AuthDtos {
    private AuthDtos() {}

    public record RegisterRequest(
        String email,
        String password,
        String fullName,
        String gender,
        String nationalityCode
    ) {}

    public record LoginRequest(
        String email,
        String password
    ) {}

    public record UpdateProfileRequest(
        String fullName,
        String gender,
        String nationalityCode
    ) {}

    public record UpdatePlanRequest(
        String planTier
    ) {}

    public record UserDto(
        String userId,
        String email,
        String fullName,
        String gender,
        String nationalityCode,
        String planTier
    ) {}

    public record AuthResponse(
        String token,
        UserDto user
    ) {}

    public record MeResponse(
        UserDto user
    ) {}
}

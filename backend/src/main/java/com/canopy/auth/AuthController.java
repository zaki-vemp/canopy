package com.canopy.auth;

import com.canopy.auth.AuthDtos.AuthResponse;
import com.canopy.auth.AuthDtos.LoginRequest;
import com.canopy.auth.AuthDtos.MeResponse;
import com.canopy.auth.AuthDtos.RegisterRequest;
import com.canopy.auth.AuthDtos.UpdatePlanRequest;
import com.canopy.auth.AuthDtos.UpdateProfileRequest;
import com.canopy.auth.AuthDtos.UserDto;
import com.canopy.auth.UserRepository.UserRow;
import com.canopy.security.AuthPrincipal;
import com.canopy.security.JwtAuthFilter;
import com.canopy.security.JwtService;
import com.canopy.util.UuidV7;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

@RestController
public class AuthController {
    private static final Pattern EMAIL_PATTERN = Pattern.compile("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$");
    private static final Pattern ISO_COUNTRY_PATTERN = Pattern.compile("^[A-Z]{2}$");

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;

    public AuthController(
        UserRepository userRepository,
        PasswordEncoder passwordEncoder,
        JwtService jwtService
    ) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
    }

    @PostMapping("/api/auth/register")
    public ResponseEntity<AuthResponse> register(
        @RequestBody RegisterRequest req,
        @RequestParam(name = "tabOnly", defaultValue = "false") boolean tabOnly,
        HttpServletResponse response
    ) {
        if (req == null) {
            throw new IllegalArgumentException("Missing registration payload");
        }
        String email = validateEmail(req.email());
        validatePassword(req.password());
        String fullName = validateFullName(req.fullName());
        String gender = validateGender(req.gender());
        String nationalityCode = validateNationalityCode(req.nationalityCode());

        if (userRepository.findByEmail(email).isPresent()) {
            throw new DuplicateKeyException("Email is already registered");
        }

        byte[] pubId = UuidV7.generate();
        String hash = passwordEncoder.encode(req.password());
        UserRow user = userRepository.insert(pubId, email, hash, fullName, gender, nationalityCode);

        String token = jwtService.createToken(user.id(), user.publicId(), user.email());
        if (!tabOnly) {
            writeAuthCookie(response, token, jwtService.getExpirationSeconds());
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(new AuthResponse(token, user.toDto()));
    }

    @PostMapping("/api/auth/login")
    public ResponseEntity<AuthResponse> login(
        @RequestBody LoginRequest req,
        @RequestParam(name = "tabOnly", defaultValue = "false") boolean tabOnly,
        HttpServletResponse response
    ) {
        if (req == null || req.email() == null || req.password() == null) {
            throw new IllegalArgumentException("Email and password are required");
        }
        String email = req.email().trim().toLowerCase(Locale.ROOT);
        UserRow user = userRepository.findByEmail(email)
            .orElseThrow(() -> new BadCredentialsException("Invalid email or password"));
        if (!passwordEncoder.matches(req.password(), user.passwordHash())) {
            throw new BadCredentialsException("Invalid email or password");
        }

        String token = jwtService.createToken(user.id(), user.publicId(), user.email());
        if (!tabOnly) {
            writeAuthCookie(response, token, jwtService.getExpirationSeconds());
        }
        return ResponseEntity.ok(new AuthResponse(token, user.toDto()));
    }

    @PostMapping("/api/auth/logout")
    public Map<String, Boolean> logout(HttpServletResponse response) {
        writeAuthCookie(response, "", 0);
        return Map.of("ok", true);
    }

    @GetMapping("/api/auth/me")
    public MeResponse me(@AuthenticationPrincipal AuthPrincipal principal) {
        UserRow user = requireUser(principal);
        return new MeResponse(user.toDto());
    }

    @PatchMapping("/api/auth/me")
    public MeResponse updateMe(
        @AuthenticationPrincipal AuthPrincipal principal,
        @RequestBody UpdateProfileRequest req
    ) {
        if (req == null) {
            throw new IllegalArgumentException("Missing update payload");
        }
        UserRow existing = requireUser(principal);
        String fullName = req.fullName() != null ? validateFullName(req.fullName()) : existing.fullName();
        String gender = req.gender() != null ? validateGender(req.gender()) : existing.gender();
        String nationalityCode = req.nationalityCode() != null
            ? validateNationalityCode(req.nationalityCode())
            : existing.nationalityCode();

        userRepository.updateProfile(existing.id(), fullName, gender, nationalityCode);
        UserDto updated = new UserDto(
            UuidV7.toHex(existing.publicId()),
            existing.email(),
            fullName,
            gender,
            nationalityCode,
            existing.planTier()
        );
        return new MeResponse(updated);
    }

    @PostMapping("/api/auth/plan")
    public MeResponse updatePlan(
        @AuthenticationPrincipal AuthPrincipal principal,
        @RequestBody UpdatePlanRequest req
    ) {
        if (req == null || req.planTier() == null) {
            throw new IllegalArgumentException("planTier is required");
        }
        String planTier = req.planTier().trim().toUpperCase(Locale.ROOT);
        if (!planTier.equals("FREE") && !planTier.equals("PREMIUM")) {
            throw new IllegalArgumentException("planTier must be FREE or PREMIUM");
        }
        UserRow existing = requireUser(principal);
        userRepository.updatePlanTier(existing.id(), planTier);
        UserDto updated = new UserDto(
            UuidV7.toHex(existing.publicId()),
            existing.email(),
            existing.fullName(),
            existing.gender(),
            existing.nationalityCode(),
            planTier
        );
        return new MeResponse(updated);
    }

    @GetMapping("/api/health")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }

    private UserRow requireUser(AuthPrincipal principal) {
        if (principal == null) {
            throw new BadCredentialsException("Authentication required");
        }
        UserRow user = userRepository.findById(principal.userId())
            .orElseThrow(() -> new BadCredentialsException("Account session is no longer valid"));
        if (!Arrays.equals(user.publicId(), principal.userPublicId())) {
            throw new BadCredentialsException("Account session is no longer valid");
        }
        return user;
    }

    private static void writeAuthCookie(HttpServletResponse response, String value, long maxAgeSeconds) {
        ResponseCookie cookie = ResponseCookie.from(JwtAuthFilter.COOKIE_NAME, value)
            .httpOnly(true)
            .sameSite("Lax")
            .path("/")
            .maxAge(maxAgeSeconds)
            .build();
        response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString());
    }

    private static String validateEmail(String raw) {
        if (raw == null) {
            throw new IllegalArgumentException("Email is required");
        }
        String email = raw.trim().toLowerCase(Locale.ROOT);
        if (email.isEmpty() || email.length() > 190 || !EMAIL_PATTERN.matcher(email).matches()) {
            throw new IllegalArgumentException("Valid email is required");
        }
        return email;
    }

    private static void validatePassword(String password) {
        if (password == null || password.length() < 6) {
            throw new IllegalArgumentException("Password must be at least 6 characters");
        }
        if (password.getBytes(StandardCharsets.UTF_8).length > 72) {
            throw new IllegalArgumentException("Password must not exceed 72 bytes");
        }
    }

    private static String validateFullName(String raw) {
        if (raw == null) {
            throw new IllegalArgumentException("Full name is required");
        }
        String name = raw.trim();
        if (name.isEmpty() || name.length() > 100) {
            throw new IllegalArgumentException("Full name must be 1 to 100 characters");
        }
        return name;
    }

    private static String validateGender(String raw) {
        if (raw == null) {
            throw new IllegalArgumentException("Gender is required");
        }
        String gender = raw.trim();
        if (gender.isEmpty() || gender.length() > 32) {
            throw new IllegalArgumentException("Gender must be 1 to 32 characters");
        }
        return gender;
    }

    private static String validateNationalityCode(String raw) {
        if (raw == null) {
            throw new IllegalArgumentException("Nationality code is required");
        }
        String code = raw.trim().toUpperCase(Locale.ROOT);
        if (!ISO_COUNTRY_PATTERN.matcher(code).matches()) {
            throw new IllegalArgumentException("Nationality code must be a 2-letter uppercase ISO code");
        }
        return code;
    }
}

package com.canopy.media;

import com.canopy.security.AuthPrincipal;
import com.canopy.util.UuidV7;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.Locale;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.Set;

@RestController
public class AttachmentController {
    private static final Set<String> ALLOWED_KINDS = Set.of("image", "file", "voice_note");
    private static final long MAX_BYTES = 20L * 1024 * 1024;

    private record StoredAttachment(
        long id,
        long messageId,
        long podId,
        long uploaderUserId,
        String fileName,
        String mimeType,
        long sizeBytes,
        String storagePath
    ) {}

    private record DmParticipants(long dmLow, long dmHigh) {}

    private final JdbcClient jdbc;
    private final Path uploadsDir;

    public AttachmentController(
        JdbcClient jdbc,
        @Value("${canopy.uploads-dir:uploads}") String uploadsDir
    ) {
        // ponytail: local disk attachment storage; swap to S3/R2 object storage for multi-instance deployments
        this.jdbc = jdbc;
        this.uploadsDir = Paths.get(uploadsDir).toAbsolutePath().normalize();
    }

    @PostMapping(path = "/api/pods/{podId}/attachments", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<AttachmentDto> upload(
        @PathVariable("podId") String podId,
        @RequestParam("file") MultipartFile file,
        @RequestParam(name = "kind", defaultValue = "file") String kind,
        @RequestParam(name = "durationMs", defaultValue = "0") int durationMs,
        @AuthenticationPrincipal AuthPrincipal principal
    ) {
        if (principal == null) {
            throw new BadCredentialsException("Authentication required");
        }
        byte[] podPubId = UuidV7.fromHex(podId);
        long internalPodId = jdbc.sql("SELECT id FROM pods WHERE public_id = :pubId")
            .param("pubId", podPubId)
            .query((rs, rowNum) -> rs.getLong("id"))
            .optional()
            .orElseThrow(() -> new NoSuchElementException("Pod not found"));

        requirePodMember(internalPodId, principal.userId());

        String normalizedKind = kind == null ? "file" : kind.trim().toLowerCase(Locale.ROOT);
        if (!ALLOWED_KINDS.contains(normalizedKind)) {
            throw new IllegalArgumentException("Invalid attachment kind; expected image, file, or voice_note");
        }
        if (durationMs < 0) {
            throw new IllegalArgumentException("durationMs must be non-negative");
        }
        if (file == null || file.isEmpty() || file.getSize() <= 0) {
            throw new IllegalArgumentException("Attachment file must not be empty");
        }
        if (file.getSize() > MAX_BYTES) {
            throw new IllegalArgumentException("Attachment exceeds 20MB limit");
        }

        String safeFileName = sanitizeFileName(file.getOriginalFilename());
        String mimeType = sanitizeMimeType(file.getContentType());
        String storedName = UuidV7.toHex(UuidV7.generate()) + "_" + safeFileName;

        Path target = uploadsDir.resolve(storedName).normalize();
        if (!target.startsWith(uploadsDir)) {
            throw new SecurityException("Invalid attachment storage path");
        }

        try {
            Files.createDirectories(uploadsDir);
            try (InputStream in = file.getInputStream()) {
                Files.copy(in, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException e) {
            throw new UncheckedIOException("Failed saving attachment", e);
        }

        KeyHolder keyHolder = new GeneratedKeyHolder();
        jdbc.sql("""
                INSERT INTO message_attachments
                  (message_id, pod_id, uploader_user_id, kind, file_name, mime_type, size_bytes, duration_ms, storage_path)
                VALUES
                  (0, :podId, :uploaderUserId, :kind, :fileName, :mimeType, :sizeBytes, :durationMs, :storagePath)
                """)
            .param("podId", internalPodId)
            .param("uploaderUserId", principal.userId())
            .param("kind", normalizedKind)
            .param("fileName", safeFileName)
            .param("mimeType", mimeType)
            .param("sizeBytes", file.getSize())
            .param("durationMs", durationMs)
            .param("storagePath", storedName)
            .update(keyHolder);

        long id = Objects.requireNonNull(keyHolder.getKey(), "Missing attachment ID").longValue();
        AttachmentDto dto = new AttachmentDto(
            id,
            normalizedKind,
            safeFileName,
            mimeType,
            file.getSize(),
            durationMs,
            "/api/attachments/" + id
        );
        return ResponseEntity.status(HttpStatus.CREATED).body(dto);
    }

    @GetMapping("/api/attachments/{attachmentId}")
    public ResponseEntity<Resource> download(
        @PathVariable("attachmentId") long attachmentId,
        @AuthenticationPrincipal AuthPrincipal principal
    ) {
        if (principal == null) {
            throw new BadCredentialsException("Authentication required");
        }

        StoredAttachment row = jdbc.sql("""
                SELECT id, message_id, pod_id, uploader_user_id, file_name, mime_type, size_bytes, storage_path
                FROM message_attachments
                WHERE id = :id
                """)
            .param("id", attachmentId)
            .query((rs, rowNum) -> new StoredAttachment(
                rs.getLong("id"),
                rs.getLong("message_id"),
                rs.getLong("pod_id"),
                rs.getLong("uploader_user_id"),
                rs.getString("file_name"),
                rs.getString("mime_type"),
                rs.getLong("size_bytes"),
                rs.getString("storage_path")
            ))
            .optional()
            .orElseThrow(() -> new NoSuchElementException("Attachment not found"));

        requirePodMember(row.podId(), principal.userId());

        if (row.messageId() > 0) {
            DmParticipants dm = jdbc.sql("""
                    SELECT dm_user_low_id, dm_user_high_id
                    FROM messages
                    WHERE id = :msgId
                    """)
                .param("msgId", row.messageId())
                .query((rs, rowNum) -> new DmParticipants(
                    rs.getLong("dm_user_low_id"),
                    rs.getLong("dm_user_high_id")
                ))
                .optional()
                .orElseThrow(() -> new NoSuchElementException("Attachment message not found"));

            if (dm.dmLow() > 0 && principal.userId() != dm.dmLow() && principal.userId() != dm.dmHigh()) {
                throw new SecurityException("Private message attachment restricted to participants");
            }
        } else if (row.uploaderUserId() != principal.userId()) {
            throw new SecurityException("Unattached upload restricted to uploader");
        }

        Path candidate = Paths.get(row.storagePath());
        Path resolved = candidate.isAbsolute()
            ? candidate.normalize()
            : uploadsDir.resolve(candidate.getFileName()).normalize();
        if (!resolved.startsWith(uploadsDir) || !Files.isRegularFile(resolved)) {
            throw new NoSuchElementException("Attachment file not found");
        }

        MediaType mediaType = resolveSafeMediaType(row.mimeType());
        boolean activeContent = mediaType.getSubtype().contains("html")
            || mediaType.getSubtype().contains("svg")
            || mediaType.getSubtype().contains("javascript")
            || mediaType.getSubtype().contains("xml");
        boolean inlineSafe = !activeContent && (
            mediaType.getType().equals("image")
                || mediaType.getType().equals("audio")
                || mediaType.getType().equals("video")
        );
        ContentDisposition disposition = (inlineSafe ? ContentDisposition.inline() : ContentDisposition.attachment())
            .filename(row.fileName(), StandardCharsets.UTF_8)
            .build();

        return ResponseEntity.ok()
            .contentType(activeContent ? MediaType.APPLICATION_OCTET_STREAM : mediaType)
            .cacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePrivate())
            .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
            .body(new FileSystemResource(resolved));
    }

    private void requirePodMember(long podId, long userId) {
        boolean isMember = jdbc.sql("""
                SELECT 1
                FROM pod_members
                WHERE pod_id = :podId AND user_id = :userId
                """)
            .param("podId", podId)
            .param("userId", userId)
            .query((rs, rowNum) -> rs.getInt(1))
            .optional()
            .isPresent();
        if (!isMember) {
            throw new SecurityException("Not a member of this pod");
        }
    }

    private static String sanitizeFileName(String original) {
        if (original == null || original.isBlank()) {
            return "attachment";
        }
        String base = Paths.get(original).getFileName().toString();
        String cleaned = base.replaceAll("[^A-Za-z0-9._-]", "_");
        while (cleaned.startsWith(".")) {
            cleaned = cleaned.substring(1);
        }
        if (cleaned.isEmpty()) {
            return "attachment";
        }
        return cleaned.length() > 120 ? cleaned.substring(cleaned.length() - 120) : cleaned;
    }

    private static String sanitizeMimeType(String raw) {
        if (raw == null || raw.isBlank()) {
            return MediaType.APPLICATION_OCTET_STREAM_VALUE;
        }
        String trimmed = raw.trim();
        int semi = trimmed.indexOf(';');
        String base = (semi > 0 ? trimmed.substring(0, semi) : trimmed).trim().toLowerCase(Locale.ROOT);
        if (base.isEmpty() || base.length() > 80) {
            return MediaType.APPLICATION_OCTET_STREAM_VALUE;
        }
        return base;
    }

    private static MediaType resolveSafeMediaType(String mimeType) {
        if (mimeType == null || mimeType.isBlank()) {
            return MediaType.APPLICATION_OCTET_STREAM;
        }
        try {
            return MediaType.parseMediaType(mimeType);
        } catch (IllegalArgumentException e) {
            return MediaType.APPLICATION_OCTET_STREAM;
        }
    }
}

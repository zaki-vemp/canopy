package com.canopy.media;

public record AttachmentDto(
    long id,
    String kind,
    String fileName,
    String mimeType,
    long sizeBytes,
    int durationMs,
    String url
) {}

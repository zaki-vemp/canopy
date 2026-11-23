import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PALETTE } from '../theme/palette';

export type InlineSegment =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'spoiler'; value: string };

export type RichBlock =
  | { kind: 'codeblock'; code: string }
  | { kind: 'paragraph'; segments: InlineSegment[] };

const INLINE_TOKEN_RE = /(\|\|[^|]+\|\||\*\*[^*]+\*\*|`[^`]+`)/g;

export function parseInlineSegments(line: string): InlineSegment[] {
  const parts = line.split(INLINE_TOKEN_RE).filter((p) => p.length > 0);
  return parts.map((part): InlineSegment => {
    if (part.startsWith('||') && part.endsWith('||') && part.length > 4) {
      return { kind: 'spoiler', value: part.slice(2, -2) };
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return { kind: 'bold', value: part.slice(2, -2) };
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return { kind: 'code', value: part.slice(1, -1) };
    }
    return { kind: 'text', value: part };
  });
}

export function tokenizeRichBody(raw: string): RichBlock[] {
  if (!raw) return [];
  const blocks: RichBlock[] = [];
  const fenceSplit = raw.split(/```([\s\S]*?)```/g);
  fenceSplit.forEach((chunk, idx) => {
    if (idx % 2 === 1) {
      const cleaned = chunk.replace(/^[a-zA-Z0-9_-]+\n/, '').trimEnd();
      blocks.push({ kind: 'codeblock', code: cleaned });
    } else if (chunk.length > 0) {
      const trimmed =
        idx > 0 && chunk.startsWith('\n') ? chunk.slice(1) : chunk;
      if (trimmed.length > 0) {
        blocks.push({
          kind: 'paragraph',
          segments: parseInlineSegments(trimmed),
        });
      }
    }
  });
  return blocks;
}

const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

export function RichTextBody({ body }: { body: string }) {
  const [revealedSpoilers, setRevealedSpoilers] = useState<
    Record<string, boolean>
  >({});

  const blocks = tokenizeRichBody(body);
  if (blocks.length === 0) return null;

  const toggleSpoiler = (key: string) => {
    setRevealedSpoilers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <View style={styles.container}>
      {blocks.map((block, bIdx) => {
        if (block.kind === 'codeblock') {
          return (
            <View key={`cb-${bIdx}`} style={styles.codeBlock}>
              <Text style={styles.codeBlockText} selectable>
                {block.code}
              </Text>
            </View>
          );
        }

        // Check if paragraph contains any spoilers; if so render wrap row for reliable touch targets
        const hasSpoiler = block.segments.some((s) => s.kind === 'spoiler');
        if (!hasSpoiler) {
          return (
            <Text key={`p-${bIdx}`} style={styles.paragraphText} selectable>
              {block.segments.map((seg, sIdx) => {
                if (seg.kind === 'bold') {
                  return (
                    <Text key={sIdx} style={styles.boldText}>
                      {seg.value}
                    </Text>
                  );
                }
                if (seg.kind === 'code') {
                  return (
                    <Text key={sIdx} style={styles.inlineCode}>
                      {seg.value}
                    </Text>
                  );
                }
                return <Text key={sIdx}>{seg.value}</Text>;
              })}
            </Text>
          );
        }

        return (
          <View key={`sp-${bIdx}`} style={styles.inlineWrapRow}>
            {block.segments.map((seg, sIdx) => {
              if (seg.kind === 'spoiler') {
                const key = `${bIdx}-${sIdx}`;
                const isOpen = !!revealedSpoilers[key];
                return (
                  <Pressable
                    key={key}
                    accessibilityRole="button"
                    accessibilityLabel={
                      isOpen ? `Hide spoiler: ${seg.value}` : 'Reveal spoiler'
                    }
                    hitSlop={8}
                    onPress={() => toggleSpoiler(key)}
                    style={[
                      styles.spoilerPill,
                      isOpen ? styles.spoilerOpen : styles.spoilerHidden,
                    ]}
                  >
                    <Text
                      style={[
                        styles.spoilerText,
                        isOpen
                          ? styles.spoilerOpenText
                          : styles.spoilerHiddenText,
                      ]}
                    >
                      {isOpen ? seg.value : 'SPOILER · TAP TO REVEAL'}
                    </Text>
                  </Pressable>
                );
              }
              if (seg.kind === 'bold') {
                return (
                  <Text
                    key={sIdx}
                    style={[styles.paragraphText, styles.boldText]}
                  >
                    {seg.value}
                  </Text>
                );
              }
              if (seg.kind === 'code') {
                return (
                  <Text key={sIdx} style={styles.inlineCode}>
                    {seg.value}
                  </Text>
                );
              }
              return (
                <Text key={sIdx} style={styles.paragraphText}>
                  {seg.value}
                </Text>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 6,
  },
  paragraphText: {
    fontSize: 15,
    lineHeight: 22,
    color: PALETTE.ink,
  },
  boldText: {
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  inlineCode: {
    fontFamily: MONO_FONT,
    fontSize: 13,
    backgroundColor: PALETTE.codeBg,
    color: PALETTE.forest,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  codeBlock: {
    backgroundColor: PALETTE.charcoal,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
  },
  codeBlockText: {
    fontFamily: MONO_FONT,
    fontSize: 13,
    lineHeight: 19,
    color: PALETTE.mint,
  },
  inlineWrapRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
  },
  spoilerPill: {
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    justifyContent: 'center',
  },
  spoilerHidden: {
    backgroundColor: PALETTE.charcoal,
  },
  spoilerOpen: {
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
  },
  spoilerText: {
    fontSize: 13,
    fontWeight: '600',
  },
  spoilerHiddenText: {
    color: PALETTE.mint,
    fontFamily: MONO_FONT,
    fontSize: 11,
    letterSpacing: 0.4,
  },
  spoilerOpenText: {
    color: PALETTE.ink,
  },
});

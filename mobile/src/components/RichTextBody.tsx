import React, { useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '../theme/ui';
import { PALETTE, PIECES } from '../theme/palette';

export type InlineSegment =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'spoiler'; value: string };

export type RichBlock =
  | { kind: 'codeblock'; code: string }
  | { kind: 'paragraph'; segments: InlineSegment[] };

const INLINE_TOKEN_RE = /(\|\|[\s\S]+?\|\||\*\*[\s\S]+?\*\*|`[^`]+`)/g;

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

const MONO_FONT = 'DMMono_500Medium';

export function RichTextBody({
  body,
  compactSystem = false,
  color,
  selectable = false,
}: {
  body: string;
  compactSystem?: boolean;
  color?: string;
  /** Off in bubbles: selecting text would swallow the press that opens the message. */
  selectable?: boolean;
}) {
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
              <Text style={styles.codeBlockText} selectable={selectable}>
                {block.code}
              </Text>
            </View>
          );
        }

        // Check if paragraph contains any spoilers; if so render wrap row for reliable touch targets
        const hasSpoiler = block.segments.some((s) => s.kind === 'spoiler');
        if (!hasSpoiler) {
          return (
            <Text
              key={`p-${bIdx}`}
              style={[
                styles.paragraphText,
                compactSystem && styles.systemParagraphText,
                color ? { color } : null,
              ]}
              selectable={selectable}
            >
              {block.segments.map((seg, sIdx) => {
                if (seg.kind === 'bold') {
                  return (
                    <Text key={sIdx} style={[styles.boldText, color ? { color } : null]}>
                      {seg.value}
                    </Text>
                  );
                }
                if (seg.kind === 'code') {
                  return (
                    <Text
                      key={sIdx}
                      style={[
                        styles.inlineCode,
                        compactSystem && styles.systemInlineCode,
                      ]}
                    >
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
                      {isOpen ? seg.value : 'Spoiler. Tap to read'}
                    </Text>
                  </Pressable>
                );
              }
              if (seg.kind === 'bold') {
                return (
                  <Text
                    key={sIdx}
                    style={[styles.paragraphText, styles.boldText, color ? { color } : null]}
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
                <Text key={sIdx} style={[styles.paragraphText, color ? { color } : null]}>
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
    fontSize: 16,
    lineHeight: 22,
    color: PIECES.ink,
  },
  systemParagraphText: {
    fontSize: 13,
    lineHeight: 18,
    color: PIECES.muted,
    textAlign: 'center',
  },
  boldText: {
    fontWeight: '700',
    color: PIECES.ink,
  },
  inlineCode: {
    fontFamily: MONO_FONT,
    fontSize: 14,
    backgroundColor: PIECES.glass,
    color: PIECES.ink,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
  },
  systemInlineCode: {
    fontSize: 12,
    backgroundColor: PIECES.sheet,
  },
  codeBlock: {
    backgroundColor: PIECES.ink,
    borderRadius: 16,
    padding: 14,
  },
  codeBlockText: {
    fontFamily: MONO_FONT,
    fontSize: 13,
    lineHeight: 19,
    color: PIECES.sheet,
  },
  inlineWrapRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
  },
  spoilerPill: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    justifyContent: 'center',
  },
  spoilerHidden: {
    backgroundColor: PIECES.ink,
  },
  spoilerOpen: {
    backgroundColor: PIECES.glass,
  },
  spoilerText: {
    fontSize: 14,
    fontWeight: '600',
  },
  spoilerHiddenText: {
    color: PIECES.sheet,
    fontFamily: MONO_FONT,
    fontSize: 12,
  },
  spoilerOpenText: {
    color: PIECES.ink,
  },
});

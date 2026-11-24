import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '../theme/ui';
import {
  PIECES,
  PIECE_HEX,
  aliasInitials,
  pieceColor,
  pieceRadii,
  washed,
} from '../theme/palette';

// A person is a coloured piece: the alias's first word picks the colour, the
// animal picks the shape. Same rule as frontend/src/lib/pieces.ts.
export function Piece({
  alias,
  size = 44,
  away = false,
  speaking = false,
  style,
}: {
  alias: string;
  size?: number;
  away?: boolean;
  speaking?: boolean;
  style?: ViewStyle;
}) {
  const base = pieceColor(alias);
  const inner = (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: away ? washed(base) : base,
        },
        pieceRadii(alias, size),
        style,
      ]}
    >
      <Text
        style={{
          color: PIECES.ink,
          fontSize: Math.max(11, Math.round(size * 0.34)),
          fontWeight: '500',
          fontFamily: 'Gabarito_500Medium',
        }}
      >
        {aliasInitials(alias)}
      </Text>
    </View>
  );
  if (!speaking) return inner;
  const ring = size + 12;
  return (
    <View
      style={[
        {
          width: ring,
          height: ring,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 3,
          borderColor: PIECES.blue,
          backgroundColor: PIECES.sheet,
        },
        pieceRadii(alias, ring),
      ]}
    >
      {inner}
    </View>
  );
}

const LOGO: Array<{
  ch: string;
  color: string | null;
  r: [number, number, number, number];
}> = [
  { ch: 'C', color: PIECE_HEX.cobalt, r: [9, 9, 9, 0] },
  { ch: 'a', color: PIECE_HEX.amber, r: [0, 0, 99, 99] },
  { ch: 'n', color: PIECE_HEX.slate, r: [99, 99, 99, 99] },
  { ch: 'o', color: PIECE_HEX.coral, r: [99, 99, 9, 9] },
  { ch: 'p', color: PIECE_HEX.jade, r: [9, 99, 99, 9] },
  { ch: 'y', color: null, r: [9, 9, 9, 9] },
];

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <View
      accessible
      accessibilityLabel="Canopy"
      style={{ flexDirection: 'row', gap: 3 }}
    >
      {LOGO.map((l) => (
        <View
          key={l.ch}
          style={{
            width: size,
            height: size,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: l.color ?? 'transparent',
            borderWidth: l.color ? 0 : 2,
            borderColor: PIECES.ink,
            borderTopLeftRadius: l.r[0],
            borderTopRightRadius: l.r[1],
            borderBottomRightRadius: l.r[2],
            borderBottomLeftRadius: l.r[3],
          }}
        >
          <Text
            style={{
              color: PIECES.ink,
              fontSize: Math.round(size * 0.6),
              fontFamily: 'Gabarito_500Medium',
            }}
          >
            {l.ch}
          </Text>
        </View>
      ))}
    </View>
  );
}

// Seats in a room: filled dots are people, empty rings are free chairs.
export function SeatDots({
  taken,
  total,
  size = 8,
}: {
  taken: number;
  total: number;
  size?: number;
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 3, maxWidth: (size + 3) * 10 }}>
      {Array.from({ length: total }, (_, i) => (
        <View
          key={i}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: i < taken ? PIECES.ink : 'transparent',
            borderWidth: i < taken ? 0 : 1.5,
            borderColor: PIECES.ink,
            opacity: i < taken ? 1 : 0.45,
          }}
        />
      ))}
    </View>
  );
}


// Buttons are pills, one colour per meaning: blue for the main press, ink for
// a held choice, glass (grey) for the rest, off (coral) for leaving.
export type BtnKind = 'blue' | 'ink' | 'glass' | 'off' | 'white';

const BTN_BG: Record<BtnKind, string> = {
  blue: PIECES.blue,
  ink: PIECES.ink,
  glass: PIECES.bg,
  off: PIECES.off,
  white: PIECES.sheet,
};

export function Btn({
  label,
  onPress,
  kind = 'glass',
  icon,
  disabled,
  loading,
  big,
  wide,
  style,
  a11yLabel,
}: {
  label: string;
  onPress: () => void;
  kind?: BtnKind;
  icon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
  loading?: boolean;
  big?: boolean;
  wide?: boolean;
  style?: ViewStyle;
  a11yLabel?: string;
}) {
  const light = kind === 'blue' || kind === 'ink';
  const fg = light ? PIECES.sheet : PIECES.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11yLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: big ? 56 : 44,
          paddingHorizontal: big ? 28 : 18,
          borderRadius: big ? 28 : 22,
          backgroundColor:
            pressed && kind === 'blue' ? PIECES.blueDown : BTN_BG[kind],
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          opacity: disabled ? 0.45 : 1,
          alignSelf: wide ? 'stretch' : 'auto',
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={big ? 20 : 17} color={fg} /> : null}
          <Text
            style={{
              color: fg,
              fontSize: big ? 17 : 15,
              fontWeight: '600',
              fontFamily: big ? 'Gabarito_500Medium' : undefined,
            }}
            numberOfLines={1}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

// A held choice: ink fill with white text when on, grey when off.
export function Chip({
  label,
  active,
  onPress,
  a11yLabel,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  a11yLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11yLabel ?? label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        minHeight: 44,
        paddingHorizontal: 16,
        borderRadius: 22,
        backgroundColor: active ? PIECES.ink : PIECES.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          fontSize: 15,
          fontWeight: '600',
          color: active ? PIECES.sheet : PIECES.ink,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// Count badge: blue disc, white number.
export function Badge({ n, onBlue }: { n: number; onBlue?: boolean }) {
  return (
    <View
      style={{
        minWidth: 24,
        height: 24,
        paddingHorizontal: 6,
        borderRadius: 12,
        backgroundColor: onBlue ? PIECES.sheet : PIECES.blue,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          fontSize: 13,
          fontWeight: '700',
          color: onBlue ? PIECES.blue : PIECES.sheet,
        }}
      >
        {n}
      </Text>
    </View>
  );
}

export const fieldStyles = StyleSheet.create({
  input: {
    minHeight: 56,
    borderRadius: 28,
    backgroundColor: PIECES.bg,
    paddingHorizontal: 22,
    fontSize: 16,
    color: PIECES.ink,
  },
  multi: {
    minHeight: 96,
    borderRadius: 24,
    backgroundColor: PIECES.bg,
    paddingHorizontal: 22,
    paddingVertical: 16,
    fontSize: 16,
    color: PIECES.ink,
    textAlignVertical: 'top',
  },
  label: { fontSize: 15, fontWeight: '600', color: PIECES.ink },
  hint: { fontSize: 14, lineHeight: 20, color: PIECES.muted },
});

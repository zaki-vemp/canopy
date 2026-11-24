// Pieces design tokens, mirrored from frontend/src/app/globals.css.
// White sheets on a #f4f4f4 table, #111111 ink, one blue (#1a4be0) for anything
// pressed, and twelve alias colours for people and what they send. Zero violet.
//
// The PALETTE keys below are older names that screens already use; they now map
// onto Pieces values so every screen picks the new look up from one place.
export const PIECES = {
  bg: '#f4f4f4',
  sheet: '#ffffff',
  ink: '#111111',
  ink2: '#333333',
  muted: '#5c5c5c',
  hair: '#d8d8d8',
  blue: '#1a4be0',
  blueDown: '#143cb8',
  off: '#f19079',
  alarm: '#a3200d',
  glass: 'rgba(255,255,255,0.6)',
} as const;

export const PIECE_HEX = {
  amber: '#e6a92e',
  cobalt: '#7396f2',
  cedar: '#c9855c',
  slate: '#9cadb9',
  mint: '#9bddbb',
  coral: '#f19079',
  flint: '#b4afa6',
  ochre: '#cf9f45',
  birch: '#eae0c8',
  jade: '#5cbb91',
  teal: '#55b5b3',
  quartz: '#e8c7c9',
} as const;

export const PALETTE = {
  charcoal: PIECES.ink,
  surface: PIECES.bg,
  surfaceMuted: '#ebebeb',
  card: PIECES.sheet,
  ink: PIECES.ink,
  muted: PIECES.muted,
  mint: PIECE_HEX.mint,
  mintSoft: PIECES.bg,
  mintBorder: PIECES.hair,
  forest: PIECES.blue,
  danger: PIECES.alarm,
  dangerSoft: '#fbe3dd',
  border: PIECES.hair,
  borderStrong: '#bdbdbd',
  codeBg: '#ececec',
  amber: '#7a5200',
  amberSoft: '#fbefd2',
  teal: '#1f6f6d',
  slate: '#3a4a54',
  blue: PIECES.blue,
  blueDown: PIECES.blueDown,
  off: PIECES.off,
} as const;

export const TOUCH_MIN = 44;

export type PieceColorName = keyof typeof PIECE_HEX;
export const PIECE_NAMES = Object.keys(PIECE_HEX) as PieceColorName[];

// Corner radii as fractions of the piece size, in CSS order: tl tr br bl.
const PIECE_SHAPES: Record<string, [number, number, number, number]> = {
  fox: [0.5, 0.5, 0.5, 0.5],
  heron: [0.5, 0.5, 0.28, 0.28],
  otter: [0.28, 0.5, 0.5, 0.28],
  owl: [0.28, 0.28, 0.28, 0.28],
  finch: [0.28, 0.28, 0.28, 0],
  lynx: [0.28, 0.28, 0.5, 0.5],
  badger: [0.5, 0.28, 0.28, 0.5],
  wren: [0.5, 0.28, 0.5, 0.28],
  falcon: [0.28, 0.5, 0.28, 0.5],
  ibis: [0, 0.28, 0.28, 0.28],
  marten: [0.5, 0.5, 0.5, 0],
  seal: [0.5, 0, 0.5, 0.5],
};
const ANIMALS = Object.keys(PIECE_SHAPES);

function hash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

// An alias is two words. The first picks the colour, the animal picks the
// shape. The hex the API sends is ignored on purpose.
export function pieceColor(alias: string): string {
  const word = alias.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const name = (PIECE_NAMES as string[]).includes(word)
    ? (word as PieceColorName)
    : PIECE_NAMES[hash(alias) % PIECE_NAMES.length];
  return PIECE_HEX[name];
}

export function pieceRadii(alias: string, size: number) {
  const animal = alias.trim().split(/\s+/)[1]?.toLowerCase() ?? '';
  const r = PIECE_SHAPES[animal] ?? PIECE_SHAPES[ANIMALS[hash(alias) % ANIMALS.length]];
  return {
    borderTopLeftRadius: r[0] * size,
    borderTopRightRadius: r[1] * size,
    borderBottomRightRadius: r[2] * size,
    borderBottomLeftRadius: r[3] * size,
  };
}

// Kept so older call sites keep compiling; the API colour is never used.
export function safePeerColor(_rawColor?: string | null, alias = ''): string {
  return pieceColor(alias);
}

// Away pieces are the colour washed 66% toward white.
export function washed(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c * 0.34 + 255 * 0.66);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

export function capacityTierBadge(memberCount: number, maxMembers: number): string {
  if (maxMembers <= 10) return `Compact ${memberCount}/${maxMembers}`;
  if (maxMembers <= 25) return `Standard ${memberCount}/${maxMembers}`;
  return `Club ${memberCount}/${maxMembers}`;
}

export function aliasInitials(alias: string): string {
  const parts = alias.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

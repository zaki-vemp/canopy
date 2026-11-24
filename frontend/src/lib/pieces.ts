import type { CSSProperties } from 'react';

// An alias is two words. The first picks the colour and the animal picks the
// shape, so each of the 144 aliases is its own piece wherever it appears.
export const PIECE_COLORS = [
  'amber',
  'cobalt',
  'cedar',
  'slate',
  'mint',
  'coral',
  'flint',
  'ochre',
  'birch',
  'jade',
  'teal',
  'quartz',
] as const;

const PIECE_SHAPES: Record<string, string> = {
  fox: '50%',
  heron: '50% 50% 28% 28%',
  otter: '28% 50% 50% 28%',
  owl: '28%',
  finch: '28% 28% 28% 0',
  lynx: '28% 28% 50% 50%',
  badger: '50% 28% 28% 50%',
  wren: '50% 28% 50% 28%',
  falcon: '28% 50% 28% 50%',
  ibis: '0 28% 28% 28%',
  marten: '50% 50% 50% 0',
  seal: '50% 0 50% 50%',
};

const ANIMALS = Object.keys(PIECE_SHAPES);

function hash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

export function pieceColor(alias: string): string {
  const word = alias.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const known = (PIECE_COLORS as readonly string[]).includes(word);
  return `var(--c-${known ? word : PIECE_COLORS[hash(alias) % PIECE_COLORS.length]})`;
}

export function pieceShape(alias: string): string {
  const animal = alias.trim().split(/\s+/)[1]?.toLowerCase() ?? '';
  return PIECE_SHAPES[animal] ?? PIECE_SHAPES[ANIMALS[hash(alias) % ANIMALS.length]];
}

export function colorVar(alias: string): CSSProperties {
  return { '--c': pieceColor(alias) } as CSSProperties;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

export function dealAlias(rand: () => number = Math.random): string {
  const pick = (list: readonly string[]) => list[Math.floor(rand() * list.length)];
  return [pick(PIECE_COLORS), pick(ANIMALS)]
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

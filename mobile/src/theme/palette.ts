// Canopy white-mint-tiles design tokens (Zero Violet)
export const PALETTE = {
  charcoal: '#191b19',
  surface: '#f5f6f5',
  surfaceMuted: '#ecefec',
  card: '#ffffff',
  ink: '#232323',
  muted: '#686868',
  mint: '#a1ffcb',
  mintSoft: '#e6fbee',
  mintBorder: '#7be4ac',
  forest: '#1f6b3a',
  danger: '#b42318',
  dangerSoft: '#fdeceb',
  border: '#dfe3df',
  borderStrong: '#c8cec8',
  codeBg: '#f0f2f0',
  amber: '#9a5b13',
  amberSoft: '#fef6e7',
  teal: '#0f5c5c',
  slate: '#37474f',
} as const;

export const TOUCH_MIN = 44;

const SAFE_PEER_PALETTE = [
  '#1f6b3a',
  '#0f5c5c',
  '#2c5e4f',
  '#8c5319',
  '#37474f',
  '#235742',
  '#4d5e28',
  '#7a3e26',
];

/**
 * Ensures zero purple/violet/indigo hues ever appear in peer pills or rings.
 */
export function safePeerColor(rawColor?: string | null, fallbackSeed = ''): string {
  if (rawColor && /^#[0-9a-fA-F]{6}$/.test(rawColor)) {
    const r = parseInt(rawColor.slice(1, 3), 16);
    const g = parseInt(rawColor.slice(3, 5), 16);
    const b = parseInt(rawColor.slice(5, 7), 16);
    // Reject violet/purple/indigo where blue dominates green and red+blue are elevated
    const isVioletish = b > g + 25 && r > 65 && b > 110;
    const isIndigoish = b > g + 45 && b > r + 20;
    if (!isVioletish && !isIndigoish) {
      return rawColor;
    }
  }
  let hash = 0;
  for (let i = 0; i < fallbackSeed.length; i++) {
    hash = (hash * 31 + fallbackSeed.charCodeAt(i)) >>> 0;
  }
  return SAFE_PEER_PALETTE[hash % SAFE_PEER_PALETTE.length];
}

export function capacityTierBadge(memberCount: number, maxMembers: number): string {
  if (maxMembers <= 10) return `Compact ${memberCount}/${maxMembers}`;
  if (maxMembers <= 25) return `Standard ${memberCount}/${maxMembers}`;
  return `Club ${memberCount}/${maxMembers}`;
}

export function aliasInitials(alias: string): string {
  const parts = alias.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

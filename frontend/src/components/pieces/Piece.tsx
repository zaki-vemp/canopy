import type { CSSProperties } from 'react';
import { initials, pieceColor, pieceShape } from '@/lib/pieces';
import ui from './ui.module.css';

export function Piece({
  alias,
  size = 44,
  away = false,
  speaking = false,
}: {
  alias: string;
  size?: number;
  away?: boolean;
  speaking?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`${ui.piece} ${away ? ui.away : ''} ${speaking ? ui.speaking : ''}`}
      style={
        {
          '--c': pieceColor(alias),
          '--s': `${size}px`,
          borderRadius: pieceShape(alias),
        } as CSSProperties
      }
    >
      {initials(alias)}
    </span>
  );
}

export function Logo() {
  const colors = ['cobalt', 'amber', 'slate', 'coral', 'jade'];
  return (
    <span className={ui.logo} aria-hidden="true">
      {[...'Canopy'].map((letter, i) => (
        <span
          key={i}
          style={
            colors[i]
              ? ({ '--c': `var(--c-${colors[i]})` } as CSSProperties)
              : undefined
          }
        >
          {letter}
        </span>
      ))}
    </span>
  );
}

export function SeatDots({
  taken,
  total,
  columns,
}: {
  taken: number;
  total: number;
  columns: number;
}) {
  return (
    <span
      aria-hidden="true"
      className={ui.seats}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: total }, (_, i) => (
        <i key={i} data-free={i >= taken ? '' : undefined} />
      ))}
    </span>
  );
}

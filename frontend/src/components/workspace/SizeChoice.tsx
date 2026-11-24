'use client';

import { SeatDots } from '@/components/pieces/Piece';
import type { PodCapacityPreset } from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';

const SIZES = [
  { value: 10, name: 'Compact', columns: 5 },
  { value: 25, name: 'Standard', columns: 5 },
  { value: 50, name: 'Club', columns: 10 },
] as const;

export function SizeChoice({
  value,
  onChange,
  any = false,
  onColor = false,
}: {
  value: PodCapacityPreset;
  onChange: (value: PodCapacityPreset) => void;
  any?: boolean;
  onColor?: boolean;
}) {
  const cls = `${ui.choice} ${onColor ? ui.onColor : ''}`;
  return (
    <div className={ui.choices} role="group" aria-label="Room size">
      {any && (
        <button type="button" className={cls} aria-pressed={value === null} onClick={() => onChange(null)}>
          Any size
        </button>
      )}
      {SIZES.map((size) => (
        <button
          key={size.value}
          type="button"
          className={cls}
          aria-pressed={value === size.value}
          onClick={() => onChange(size.value)}
        >
          {size.value} seats
          {!onColor && <small>{size.name}</small>}
          {!onColor && (
            <span style={{ display: 'block', maxWidth: size.columns * 12, margin: '8px auto 0' }}>
              <SeatDots taken={size.value} total={size.value} columns={size.columns} />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

import assert from 'node:assert/strict';
import { PIECE_COLORS, dealAlias, initials, pieceColor, pieceShape } from './pieces';

export function verifyPieces(): void {
  assert.equal(pieceColor('Cobalt Fox'), 'var(--c-cobalt)');
  assert.equal(pieceColor('cobalt heron'), 'var(--c-cobalt)');
  assert.match(pieceColor('System'), /^var\(--c-[a-z]+\)$/);
  assert.equal(pieceColor('System'), pieceColor('System'));

  const animals = ['Fox', 'Heron', 'Otter', 'Owl', 'Finch', 'Lynx', 'Badger', 'Wren', 'Falcon', 'Ibis', 'Marten', 'Seal'];
  const pieces = new Set(
    PIECE_COLORS.flatMap((c) => animals.map((a) => pieceColor(`${c} ${a}`) + pieceShape(`${c} ${a}`)))
  );
  assert.equal(pieces.size, 144, 'every alias is its own piece');

  assert.equal(initials('Jade Otter'), 'JO');
  assert.equal(initials('Chess'), 'Ch');
  assert.equal(initials(''), '?');
  assert.equal(dealAlias(() => 0), 'Amber Fox');
  assert.equal(dealAlias(() => 0.999), 'Quartz Seal');
}

verifyPieces();

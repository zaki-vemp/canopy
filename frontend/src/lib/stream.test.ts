import assert from 'node:assert/strict';
import { follows, newDay, serverWords, toRows } from './stream';

const line = (
  id: number,
  msgType: 'TEXT' | 'SYSTEM' | 'POLL',
  body: string,
  senderPeerId = 'p_a',
  createdAt = '2026-11-24T10:00:00Z'
) => ({ id, msgType, body, senderPeerId, createdAt });

export function verifyStream(): void {
  const rows = toRows([
    line(1, 'SYSTEM', 'Jade Otter joined the pod'),
    line(2, 'SYSTEM', 'Cobalt Fox joined via invite link'),
    line(3, 'TEXT', 'Slate Owl joined the pod'),
    line(4, 'SYSTEM', 'Teal Wren joined the group'),
    line(5, 'SYSTEM', 'Slate Owl was removed by Teal Wren'),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.joined]),
    [
      [1, ['Jade Otter', 'Cobalt Fox']],
      [3, []],
      [4, ['Teal Wren']],
      [5, []],
    ],
    'runs of joins fold; a message that only says so does not'
  );

  const a = line(1, 'TEXT', 'one');
  assert.equal(follows(undefined, a), false);
  assert.equal(follows(a, line(2, 'TEXT', 'two', 'p_a', '2026-11-24T10:04:00Z')), true);
  assert.equal(follows(a, line(2, 'TEXT', 'two', 'p_a', '2026-11-24T10:06:00Z')), false);
  assert.equal(follows(a, line(2, 'TEXT', 'two', 'p_b')), false);
  assert.equal(follows(a, line(2, 'POLL', 'two')), false);

  const noon = new Date('2026-11-24T12:00:00');
  const at = (iso: string) => line(1, 'TEXT', '', 'p_a', iso);
  assert.equal(newDay(undefined, at('2026-11-24T10:00:00'), noon), '', 'a room that starts today needs no date');
  assert.equal(newDay(at('2026-11-23T10:00:00'), at('2026-11-24T10:00:00'), noon), 'Today');
  assert.equal(newDay(at('2026-11-24T09:00:00'), at('2026-11-24T10:00:00'), noon), '');
  assert.match(newDay(undefined, at('2026-11-20T10:00:00'), noon), /20/);
  assert.equal(newDay(undefined, at('not a date'), noon), '');

  assert.equal(serverWords('Rename pod to "Pod people"'), 'Rename room to "Pod people"');
  assert.equal(serverWords('Jade Otter joined the pod'), 'Jade Otter joined the room');
  assert.equal(serverWords('Pod is full'), 'Room is full');
}

verifyStream();

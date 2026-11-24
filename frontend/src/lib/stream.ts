import type { RichMessage } from '@/types/canopy';

type Line = Pick<RichMessage, 'id' | 'senderPeerId' | 'msgType' | 'body' | 'createdAt'>;

const PLAIN = new Set(['TEXT', 'VOICE_NOTE']);
const JOINED = /^(\S+ \S+) joined (?:the pod|the group|via invite link)$/;

export interface StreamRow<T extends Line> {
  id: number;
  msg: T;
  // People who sat down one after another share one line.
  joined: string[];
}

export function toRows<T extends Line>(messages: T[]): StreamRow<T>[] {
  const rows: StreamRow<T>[] = [];
  for (const msg of messages) {
    const alias = msg.msgType === 'SYSTEM' ? JOINED.exec(msg.body)?.[1] : undefined;
    const last = rows[rows.length - 1];
    if (alias && last?.joined.length) last.joined.push(alias);
    else rows.push({ id: msg.id, msg, joined: alias ? [alias] : [] });
  }
  return rows;
}

// The same person, within five minutes, in plain messages: no name again.
export function follows(prev: Line | undefined, msg: Line): boolean {
  return Boolean(
    prev &&
      prev.senderPeerId === msg.senderPeerId &&
      PLAIN.has(prev.msgType) &&
      PLAIN.has(msg.msgType) &&
      Date.parse(msg.createdAt) - Date.parse(prev.createdAt) < 5 * 60_000
  );
}

// The day a message opens, or '' when the one above it is from the same day.
export function newDay(prev: Line | undefined, msg: Line, today = new Date()): string {
  const day = new Date(msg.createdAt);
  if (Number.isNaN(day.getTime())) return '';
  if (prev && new Date(prev.createdAt).toDateString() === day.toDateString()) return '';
  if (day.toDateString() === today.toDateString()) return prev ? 'Today' : '';
  return day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

// The server still says "pod" in the lines it writes itself. Only the first one
// is swapped, so a quoted room title keeps the words people gave it.
export function serverWords(text: string): string {
  return text.replace(/\bpod\b/i, (m) => (m[0] === 'P' ? 'Room' : 'room'));
}

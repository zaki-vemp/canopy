'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { apiFetch } from '@/lib/api';
import { colorVar, initials } from '@/lib/pieces';
import {
  activePodIdAtom,
  commandModalOpenAtom,
  highlightedMessageIdAtom,
  presenceByPodAtom,
} from '@/state/workspaceAtoms';
import { useVoiceActions } from '@/state/voiceEngine';
import { roomName, useOpenConversation } from '@/state/roomActions';
import { Dialog } from '@/components/pieces/Dialog';
import { Piece } from '@/components/pieces/Piece';
import { resolveMessagePeerId, type PodDetail, type RichMessage } from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import d from './dialogs.module.css';

interface Place {
  key: string;
  kind: 'room' | 'call' | 'person';
  podId: string;
  name: string;
  note: string;
  alias: string;
  peerId: string | null;
}

export function SearchDialog({ pods, pod }: { pods: PodDetail[]; pod: PodDetail | null }) {
  const [open, setOpen] = useAtom(commandModalOpenAtom);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  return open ? <Search pods={pods} pod={pod} onClose={() => setOpen(false)} /> : null;
}

function Search({
  pods,
  pod,
  onClose,
}: {
  pods: PodDetail[];
  pod: PodDetail | null;
  onClose: () => void;
}) {
  const openConversation = useOpenConversation();
  const setActivePodId = useSetAtom(activePodIdAtom);
  const setHighlighted = useSetAtom(highlightedMessageIdAtom);
  const presence = useAtomValue(presenceByPodAtom);
  const { joinVoice } = useVoiceActions();
  const [text, setText] = useState('');
  const [asked, setAsked] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setAsked(text.trim()), 180);
    return () => clearTimeout(t);
  }, [text]);

  const found = useQuery<{ messages: RichMessage[] }>({
    queryKey: ['search', pod?.podId || '', asked],
    queryFn: () =>
      apiFetch<{ messages: RichMessage[] }>(
        `/api/pods/${pod!.podId}/search?q=${encodeURIComponent(asked)}`
      ),
    enabled: Boolean(pod && asked),
  });

  const places = useMemo(() => {
    const q = text.trim().toLowerCase();
    const out: Place[] = [];
    for (const p of pods) {
      const name = roomName(p);
      const base = { podId: p.podId, alias: p.myAlias, peerId: null, note: p.code };
      const hit =
        !q ||
        [p.code, p.title, p.interestLabel].some((x) => x.toLowerCase().includes(q));
      if (hit) out.push({ ...base, key: `${p.podId}-room`, kind: 'room', name });
      if (q && (hit || 'call'.startsWith(q))) {
        out.push({ ...base, key: `${p.podId}-call`, kind: 'call', name: `Join the ${name} call` });
      }
      for (const m of presence[p.podId]?.members ?? p.members) {
        if (m.peerId === p.myPeerId) continue;
        if (!q || `${m.alias} ${m.customStatus}`.toLowerCase().includes(q)) {
          out.push({
            key: `${p.podId}-${m.peerId}`,
            kind: 'person',
            podId: p.podId,
            peerId: m.peerId,
            alias: m.alias,
            name: m.alias,
            note: pods.length > 1 ? name : m.customStatus,
          });
        }
      }
    }
    return out.slice(0, 12);
  }, [pods, presence, text]);

  const go = (x: Place) => {
    if (x.kind === 'call') {
      const target = pods.find((p) => p.podId === x.podId);
      setActivePodId(x.podId);
      joinVoice(x.podId, target ? roomName(target) : x.name);
    } else {
      openConversation(x.podId, x.peerId);
    }
    onClose();
  };

  return (
    <Dialog title="Search" width={600} onClose={onClose}>
      <input
        data-autofocus
        type="search"
        className={ui.input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && places[0]) go(places[0]);
        }}
        placeholder={pod ? `A room, a person, or words in ${roomName(pod)}` : 'A room or a person'}
        aria-label="Search rooms, people and messages"
      />

      <div className={d.places}>
        {places.map((x) => (
          <button key={x.key} type="button" onClick={() => go(x)}>
            {x.kind === 'person' ? (
              <Piece alias={x.alias} />
            ) : (
              <i className={d.roomMark} style={colorVar(x.alias)}>
                {x.kind === 'call' ? '»' : initials(x.name)}
              </i>
            )}
            <span>
              <b>{x.name}</b>
              {x.note && <small>{x.note}</small>}
            </span>
          </button>
        ))}
        {places.length === 0 && <p className={ui.hint}>No room or person by that name.</p>}
      </div>

      {pod && asked && (
        <section className={d.places}>
          <h3 className={ui.label}>Messages in {roomName(pod)}</h3>
          {found.isSuccess && found.data.messages.length === 0 && (
            <p className={ui.hint}>Nothing says “{asked}”.</p>
          )}
          {found.data?.messages.map((msg) => {
            const peerId = resolveMessagePeerId(msg.senderPeerId, msg.recipientPeerId, pod.myPeerId);
            const mine = msg.senderPeerId === pod.myPeerId;
            return (
              <button
                key={msg.id}
                type="button"
                className={d.hit}
                style={colorVar(msg.senderAlias)}
                onClick={() => {
                  openConversation(msg.podId, peerId);
                  setHighlighted(msg.id);
                  onClose();
                }}
              >
                <small>
                  {mine ? 'You' : msg.senderAlias}
                  {peerId && `, privately${mine ? ` to ${msg.recipientAlias}` : ''}`}
                </small>
                <span>{msg.body}</span>
              </button>
            );
          })}
        </section>
      )}
    </Dialog>
  );
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAtom, useSetAtom } from 'jotai';
import { apiFetch } from '@/lib/api';
import { highlightedMessageIdAtom, unreadByConvoAtom } from '@/state/workspaceAtoms';
import { markConversationReadInCaches } from '@/state/wsPodClient';
import { follows, newDay, toRows } from '@/lib/stream';
import { roomName } from '@/state/roomActions';
import { MessageCard } from '@/components/workspace/MessageCard';
import { Piece } from '@/components/pieces/Piece';
import {
  conversationKey,
  messageQueryKey,
  type MessagesPage,
  type PodDetail,
  type PodMember,
  type RichMessage,
} from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import c from '@/app/app/chat.module.css';

function Joined({ aliases }: { aliases: string[] }) {
  const names = aliases.length > 3 ? aliases.slice(0, 2) : aliases;
  const rest = aliases.length - names.length;
  const list = rest > 0 ? [...names, `${rest} more`] : names;
  return (
    <div className={c.joined}>
      <span>
        {aliases.slice(0, 14).map((alias, i) => (
          <Piece key={`${alias}-${i}`} alias={alias} size={38} />
        ))}
      </span>
      <p>
        {list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0]}{' '}
        sat down
      </p>
    </div>
  );
}

export function MessageStream({
  pod,
  activePeer,
  knownAliases,
}: {
  pod: PodDetail;
  activePeer: PodMember | null;
  knownAliases: string[];
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const queryClient = useQueryClient();
  const [highlightedId, setHighlightedId] = useAtom(highlightedMessageIdAtom);
  const setUnread = useSetAtom(unreadByConvoAtom);
  const [nearBottom, setNearBottom] = useState(true);
  const lastPostedReadRef = useRef<Record<string, number>>({});
  const anchorIdRef = useRef<number | null>(null);

  const peerId = activePeer?.peerId ?? null;
  const convoKey = conversationKey(pod.podId, peerId);

  const query = useInfiniteQuery<MessagesPage, Error>({
    queryKey: messageQueryKey(pod.podId, peerId),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiFetch<MessagesPage>(
        `/api/pods/${pod.podId}/${
          peerId ? `dms/${encodeURIComponent(peerId)}/` : ''
        }messages?beforeId=${pageParam}&limit=40`
      ),
    getNextPageParam: (last) => (last.nextBeforeId > 0 ? last.nextBeforeId : undefined),
  });

  const messages = useMemo<RichMessage[]>(() => {
    const seen = new Set<number>();
    return [...(query.data?.pages ?? [])]
      .reverse()
      .flatMap((page) => page.messages)
      .filter((m) => !seen.has(m.id) && seen.add(m.id));
  }, [query.data]);

  const rows = useMemo(() => toRows(messages), [messages]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    getItemKey: (i) => rows[i].id,
    estimateSize: () => 92,
    overscan: 8,
  });

  const openedConvoRef = useRef<string | null>(null);
  const prevLastIdRef = useRef<number | null>(null);

  useEffect(() => {
    prevLastIdRef.current = null;
    setNearBottom(true);
  }, [convoKey]);

  // Clear the badge and move the server's read cursor, once per newest message.
  useEffect(() => {
    setUnread((prev) => (prev[convoKey] === 0 ? prev : { ...prev, [convoKey]: 0 }));
    markConversationReadInCaches(queryClient, pod.podId, peerId);

    const latestId = messages.reduce((max, m) => Math.max(max, m.id), 0);
    const posted = lastPostedReadRef.current[convoKey] ?? 0;
    if (latestId <= posted) return;
    lastPostedReadRef.current[convoKey] = latestId;
    apiFetch<{ ok: boolean; lastReadMessageId: number }>(`/api/pods/${pod.podId}/read`, {
      method: 'POST',
      body: JSON.stringify({ peerId, lastReadMessageId: latestId }),
    }).catch(() => {
      if (lastPostedReadRef.current[convoKey] === latestId) {
        lastPostedReadRef.current[convoKey] = posted;
      }
    });
  }, [convoKey, messages, peerId, pod.podId, queryClient, setUnread]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) return;

    if (anchorIdRef.current !== null) {
      const idx = rows.findIndex((r) => r.id === anchorIdRef.current);
      if (idx > 0) {
        anchorIdRef.current = null;
        requestAnimationFrame(() => virtualizer.scrollToIndex(idx, { align: 'start' }));
        return;
      }
    }
    const opening = openedConvoRef.current !== convoKey;
    const grew = prevLastIdRef.current !== last.id;
    openedConvoRef.current = convoKey;
    prevLastIdRef.current = last.id;
    if (opening || (grew && (nearBottom || last.senderPeerId === pod.myPeerId))) {
      requestAnimationFrame(() =>
        virtualizer.scrollToIndex(rows.length - 1, { align: 'end' })
      );
    }
  }, [convoKey, messages, nearBottom, pod.myPeerId, rows, virtualizer]);

  useEffect(() => {
    if (!highlightedId || rows.length === 0) return;
    const idx = rows.findIndex((r) => r.id === highlightedId);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'center' });
    const timer = setTimeout(() => setHighlightedId(null), 2800);
    return () => clearTimeout(timer);
  }, [highlightedId, rows, setHighlightedId, virtualizer]);

  // A keyboard opening, a tray opening or a window resize must not push the newest block out of view.
  const nearBottomRef = useRef(true);
  nearBottomRef.current = nearBottom;
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const watch = new ResizeObserver(() => {
      if (nearBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const onScroll = () => {
    const el = viewportRef.current;
    if (el) setNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 220);
  };

  return (
    <div
      ref={viewportRef}
      className={c.stream}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      aria-label={activePeer ? `Private chat with ${activePeer.alias}` : `${roomName(pod)}, group chat`}
    >
      {query.isLoading ? null : query.isError && messages.length === 0 ? (
        <div className={c.hello}>
          <p>The messages did not load: {query.error.message}</p>
          <button type="button" className={ui.btn} onClick={() => query.refetch()}>
            Try again
          </button>
        </div>
      ) : messages.length === 0 ? (
        <div className={c.hello}>
          {activePeer ? (
            <>
              <Piece alias={activePeer.alias} size={72} />
              <h2>Nothing here yet. Say hello to {activePeer.alias}.</h2>
              <p>
                You are {pod.myAlias} to them. Nobody else in the room can read this chat or see
                that it exists.
              </p>
            </>
          ) : (
            <>
              <Piece alias={pod.myAlias} size={72} />
              <h2>You are {pod.myAlias} in here.</h2>
              <p>{pod.description || 'Say hello, or deal an icebreaker and let the room do it.'}</p>
            </>
          )}
        </div>
      ) : (
        <div className={c.pile}>
          {query.hasNextPage && (
            <div className={c.older}>
              <button
                type="button"
                className={`${ui.btn} ${ui.small}`}
                disabled={query.isFetchingNextPage}
                onClick={() => {
                  anchorIdRef.current = messages[0]?.id ?? null;
                  query.fetchNextPage();
                }}
              >
                {query.isFetchingNextPage ? 'Fetching' : 'Earlier messages'}
              </button>
            </div>
          )}
          <div className={c.streamInner} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const item = rows[row.index];
              if (!item) return null;
              const { msg, joined } = item;
              const prev = rows[row.index - 1]?.msg;
              const day = newDay(prev, msg);
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className={c.streamRow}
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  {day && <p className={c.system}>{day}</p>}
                  {joined.length > 0 ? (
                    <Joined aliases={joined} />
                  ) : (
                    <MessageCard
                      message={msg}
                      myPeerId={pod.myPeerId}
                      knownAliases={knownAliases}
                      highlighted={highlightedId === msg.id}
                      follows={!day && follows(prev, msg)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!nearBottom && messages.length > 0 && (
        <button
          type="button"
          className={`${ui.btn} ${ui.ink} ${c.jump}`}
          onClick={() => {
            virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
            setNearBottom(true);
          }}
        >
          Newest
        </button>
      )}
    </div>
  );
}

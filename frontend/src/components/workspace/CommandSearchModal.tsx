'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAtom, useSetAtom } from 'jotai';
import { Hash, MessageSquare, Search, Volume2, X } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import {
  activeChannelIdMapAtom,
  activePodIdAtom,
  activeThreadMessageIdAtom,
  commandModalOpenAtom,
  highlightedMessageIdAtom,
} from '@/state/workspaceAtoms';
import { useVoiceActions } from '@/state/voiceEngine';
import type { PodDetail, RichMessage } from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

export function CommandSearchModal({
  pods,
  activePod,
}: {
  pods: PodDetail[];
  activePod: PodDetail | null;
}) {
  const [open, setOpen] = useAtom(commandModalOpenAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const [channelMap, setChannelMap] = useAtom(activeChannelIdMapAtom);
  const setActiveThreadId = useSetAtom(activeThreadMessageIdAtom);
  const setHighlightedId = useSetAtom(highlightedMessageIdAtom);
  const { joinVoice } = useVoiceActions();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 180);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setDebouncedQuery('');
    }
  }, [open]);

  const searchQuery = useQuery<{ messages: RichMessage[] }>({
    queryKey: ['search', activePod?.podId || '', debouncedQuery],
    queryFn: () =>
      apiFetch<{ messages: RichMessage[] }>(
        `/api/pods/${activePod!.podId}/search?q=${encodeURIComponent(
          debouncedQuery
        )}`
      ),
    enabled: Boolean(open && activePod && debouncedQuery.length >= 1),
  });

  const filteredChannels = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items: Array<{
      podId: string;
      podCode: string;
      channelId: string;
      label: string;
      kind: 'TEXT' | 'VOICE';
    }> = [];
    for (const p of pods) {
      for (const ch of p.channels) {
        if (
          !q ||
          p.code.toLowerCase().includes(q) ||
          p.interestLabel.toLowerCase().includes(q) ||
          ch.label.toLowerCase().includes(q)
        ) {
          items.push({
            podId: p.podId,
            podCode: p.code,
            channelId: ch.channelId,
            label: ch.label,
            kind: ch.kind,
          });
        }
      }
    }
    return items.slice(0, 12);
  }, [pods, query]);

  if (!open) return null;

  const jumpToSearchResult = (msg: RichMessage) => {
    setActivePodId(msg.podId);
    setChannelMap({ ...channelMap, [msg.podId]: msg.channelId });
    if (msg.parentMessageId > 0) {
      setActiveThreadId(msg.parentMessageId);
    } else {
      setActiveThreadId(null);
      setHighlightedId(msg.id);
    }
    setOpen(false);
  };

  return (
    <div
      className={styles.modalOverlay}
      role="dialog"
      aria-modal="true"
      aria-label="Quick Switcher and Fulltext Search"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className={styles.modalCard} style={{ maxWidth: 580 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 16px',
            borderBottom: '1px solid rgba(35,35,35,0.12)',
          }}
        >
          <Search size={18} color="#686868" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              activePod
                ? `Jump to pod/channel or search messages in #${activePod.code}...`
                : 'Jump to pod or channel...'
            }
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              fontSize: 15,
              fontFamily: 'var(--m-font-sans)',
              color: '#232323',
            }}
            aria-label="Search pods, channels, and messages"
          />
          <button
            type="button"
            className={styles.iconSmallBtn}
            onClick={() => setOpen(false)}
            aria-label="Close search modal"
          >
            <X size={17} />
          </button>
        </div>

        <div className={styles.modalBody} style={{ padding: '12px 14px' }}>
          <div className={styles.sectionHeader}>
            <span>Pods &amp; Channels</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {filteredChannels.map((item) => (
              <button
                key={`${item.podId}-${item.channelId}`}
                type="button"
                className={styles.autocompleteItem}
                onClick={() => {
                  setActivePodId(item.podId);
                  if (item.kind === 'VOICE') {
                    joinVoice(item.podId, item.channelId, item.label);
                  } else {
                    setChannelMap({
                      ...channelMap,
                      [item.podId]: item.channelId,
                    });
                  }
                  setOpen(false);
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {item.kind === 'VOICE' ? (
                    <Volume2 size={15} color="#1f6b3a" />
                  ) : (
                    <Hash size={15} />
                  )}
                  <strong>{item.label}</strong>
                </span>
                <span
                  style={{
                    fontFamily: 'var(--m-font-mono)',
                    fontSize: 11.5,
                    color: '#686868',
                  }}
                >
                  #{item.podCode}
                </span>
              </button>
            ))}
          </div>

          {activePod && debouncedQuery.length >= 1 && (
            <div style={{ marginTop: 16 }}>
              <div className={styles.sectionHeader}>
                <span>
                  Messages in #{activePod.code} (FULLTEXT Search)
                </span>
              </div>
              {searchQuery.isLoading ? (
                <p style={{ fontSize: 13, color: '#686868', padding: '4px 8px' }}>
                  Searching...
                </p>
              ) : (searchQuery.data?.messages.length || 0) === 0 ? (
                <p style={{ fontSize: 13, color: '#686868', padding: '4px 8px' }}>
                  No matching messages found for “{debouncedQuery}”.
                </p>
              ) : (
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                >
                  {searchQuery.data!.messages.map((msg) => {
                    const ch = activePod.channels.find(
                      (c) => c.channelId === msg.channelId
                    );
                    return (
                      <button
                        key={msg.id}
                        type="button"
                        className={styles.autocompleteItem}
                        style={{
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: 4,
                          border: '1px solid rgba(35,35,35,0.09)',
                        }}
                        onClick={() => jumpToSearchResult(msg)}
                      >
                        <div
                          style={{
                            width: '100%',
                            display: 'flex',
                            justifyContent: 'space-between',
                            fontSize: 12,
                            color: '#686868',
                          }}
                        >
                          <span>
                            <strong style={{ color: '#232323' }}>
                              {msg.senderAlias}
                            </strong>{' '}
                            in #{ch?.label || 'channel'}
                            {msg.parentMessageId > 0 ? ' (thread)' : ''}
                          </span>
                          <MessageSquare size={13} />
                        </div>
                        <div
                          style={{
                            fontSize: 13.5,
                            color: '#232323',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            width: '100%',
                          }}
                        >
                          {msg.body}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

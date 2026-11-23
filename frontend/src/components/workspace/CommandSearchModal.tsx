'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { Lock, MessageSquare, Search, Users, Volume2, X } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import {
  activeDmPeerByPodAtom,
  activePodIdAtom,
  commandModalOpenAtom,
  highlightedMessageIdAtom,
  presenceByPodAtom,
  unreadByConvoAtom,
} from '@/state/workspaceAtoms';
import { useVoiceActions } from '@/state/voiceEngine';
import {
  conversationKey,
  resolveMessagePeerId,
  type PodDetail,
  type RichMessage,
} from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

interface QuickSwitchItem {
  key: string;
  podId: string;
  podCode: string;
  podTitle: string;
  label: string;
  kind: 'GROUP' | 'CALL' | 'DM';
  peerId: string | null;
}

export function CommandSearchModal({
  pods,
  activePod,
}: {
  pods: PodDetail[];
  activePod: PodDetail | null;
}) {
  const [open, setOpen] = useAtom(commandModalOpenAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const [dmPeerMap, setDmPeerMap] = useAtom(activeDmPeerByPodAtom);
  const setUnreadMap = useSetAtom(unreadByConvoAtom);
  const setHighlightedId = useSetAtom(highlightedMessageIdAtom);
  const presenceByPod = useAtomValue(presenceByPodAtom);
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

  const quickItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items: QuickSwitchItem[] = [];
    for (const p of pods) {
      const podDisplay = p.title || `#${p.code}`;
      const podMatches =
        !q ||
        p.code.toLowerCase().includes(q) ||
        p.title.toLowerCase().includes(q) ||
        p.interestLabel.toLowerCase().includes(q);

      if (podMatches || 'pod group chat'.includes(q)) {
        items.push({
          key: `${p.podId}-group`,
          podId: p.podId,
          podCode: p.code,
          podTitle: podDisplay,
          label: `Pod Group Chat (${p.memberCount}/${p.maxMembers})`,
          kind: 'GROUP',
          peerId: null,
        });
      }

      if (podMatches || 'pod audio call voice'.includes(q)) {
        items.push({
          key: `${p.podId}-call`,
          podId: p.podId,
          podCode: p.code,
          podTitle: podDisplay,
          label: 'Pod Audio Call',
          kind: 'CALL',
          peerId: null,
        });
      }

      const members = presenceByPod[p.podId]?.members ?? p.members;
      for (const m of members) {
        if (m.isSelf || m.peerId === p.myPeerId) continue;
        if (
          !q ||
          m.alias.toLowerCase().includes(q) ||
          m.customStatus.toLowerCase().includes(q)
        ) {
          items.push({
            key: `${p.podId}-dm-${m.peerId}`,
            podId: p.podId,
            podCode: p.code,
            podTitle: podDisplay,
            label: `${m.alias} · Private 1:1`,
            kind: 'DM',
            peerId: m.peerId,
          });
        }
      }
    }
    return items.slice(0, 12);
  }, [pods, presenceByPod, query]);

  if (!open) return null;

  const openConversation = (podId: string, peerId: string | null) => {
    setActivePodId(podId);
    setDmPeerMap({ ...dmPeerMap, [podId]: peerId });
    const key = conversationKey(podId, peerId);
    setUnreadMap((prev) => {
      if (!(key in prev)) return prev;
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
  };

  const jumpToSearchResult = (msg: RichMessage) => {
    const msgPod = pods.find((p) => p.podId === msg.podId) || activePod;
    const myPeerId = msgPod?.myPeerId || '';
    const otherPeerId = resolveMessagePeerId(
      msg.senderPeerId,
      msg.recipientPeerId,
      myPeerId
    );
    openConversation(msg.podId, otherPeerId);
    setHighlightedId(msg.id);
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
                ? `Jump to Group Chat, member DM, or search #${activePod.code}...`
                : 'Jump to pod or member DM...'
            }
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              fontSize: 15,
              fontFamily: 'var(--m-font-sans)',
              color: '#232323',
            }}
            aria-label="Search pods, member chats, and messages"
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
            <span>Group Chats &amp; Private Member DMs</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {quickItems.map((item) => (
              <button
                key={item.key}
                type="button"
                className={styles.autocompleteItem}
                onClick={() => {
                  if (item.kind === 'CALL') {
                    setActivePodId(item.podId);
                    joinVoice(item.podId, item.podTitle);
                  } else {
                    openConversation(item.podId, item.peerId);
                  }
                  setOpen(false);
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {item.kind === 'CALL' ? (
                    <Volume2 size={15} color="#1f6b3a" />
                  ) : item.kind === 'DM' ? (
                    <Lock size={14} color="#1f6b3a" />
                  ) : (
                    <Users size={15} color="#1f6b3a" />
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
                  Messages in #{activePod.code} (Group + Your Private DMs)
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
                    const otherPeerId = resolveMessagePeerId(
                      msg.senderPeerId,
                      msg.recipientPeerId,
                      activePod.myPeerId
                    );
                    const otherAlias =
                      msg.senderPeerId === activePod.myPeerId
                        ? msg.recipientAlias || 'Member'
                        : msg.senderAlias;

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
                            {otherPeerId
                              ? `· Private 1:1 with ${otherAlias}`
                              : '· Pod Group Chat'}
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

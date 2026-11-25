'use client';

import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { BellOff, Bookmark, CheckCheck, Plus, UserRound } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { colorVar, initials } from '@/lib/pieces';
import {
  accountDrawerOpenAtom,
  mobileNavOpenAtom,
  peerReadByConvoAtom,
  rightPanelAtom,
  unreadByConvoAtom,
  voicePeersByPodAtom,
} from '@/state/workspaceAtoms';
import { dmCallSessionAtom, voiceSessionAtom } from '@/state/voiceEngine';
import { roomName, useOpenConversation, useOpenRooms } from '@/state/roomActions';
import { Logo, Piece } from '@/components/pieces/Piece';
import {
  conversationKey,
  type DmConversationSummary,
  type PodDetail,
  type PodMember,
} from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import s from '@/app/app/workspace.module.css';

export function RoomsPanel({
  pods,
  pod,
  activePeerId,
  members,
}: {
  pods: PodDetail[];
  pod: PodDetail | null;
  activePeerId: string | null;
  members: PodMember[];
}) {
  const queryClient = useQueryClient();
  const openConversation = useOpenConversation();
  const openRooms = useOpenRooms();
  const [unread, setUnread] = useAtom(unreadByConvoAtom);
  const setPeerRead = useSetAtom(peerReadByConvoAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);
  const voice = useAtomValue(voiceSessionAtom);
  const dmCall = useAtomValue(dmCallSessionAtom);
  const setAccountOpen = useSetAtom(accountDrawerOpenAtom);
  const setNavOpen = useSetAtom(mobileNavOpenAtom);
  const [rightPanel, setRightPanel] = useAtom(rightPanelAtom);

  const dmsQuery = useQuery<{ conversations: DmConversationSummary[] }>({
    queryKey: ['dms', pod?.podId || ''],
    queryFn: () =>
      apiFetch<{ conversations: DmConversationSummary[] }>(
        `/api/pods/${pod!.podId}/dms`
      ),
    enabled: Boolean(pod?.podId),
    staleTime: 10_000,
    initialData: pod?.dmConversations
      ? { conversations: pod.dmConversations }
      : undefined,
  });

  const conversations = useMemo(
    () => dmsQuery.data?.conversations ?? pod?.dmConversations ?? [],
    [dmsQuery.data?.conversations, pod?.dmConversations]
  );

  useEffect(() => {
    if (!pod?.podId || conversations.length === 0) return;
    setPeerRead((prev) => {
      let next: Record<string, number> | null = null;
      for (const dm of conversations) {
        const readId = dm.peerLastReadMessageId ?? 0;
        const key = conversationKey(pod.podId, dm.peerId);
        if (readId > (prev[key] ?? 0)) {
          next ??= { ...prev };
          next[key] = readId;
        }
      }
      return next ?? prev;
    });
  }, [conversations, pod?.podId, setPeerRead]);

  const unreadDm = (podId: string, peerId: string, stored: number | undefined) =>
    unread[conversationKey(podId, peerId)] ?? stored ?? 0;

  const roomUnread = (p: PodDetail) => {
    if (p.myMuted) return 0;
    const group = unread[conversationKey(p.podId, null)] ?? p.unreadGroupCount ?? 0;
    if (p.podId === pod?.podId) return activePeerId === null ? 0 : group;
    return (p.dmConversations ?? []).reduce(
      (n, dm) => n + unreadDm(p.podId, dm.peerId, dm.unreadCount),
      group
    );
  };

  const totalUnread = pods.reduce((sum, p) => sum + roomUnread(p), 0);

  const markAllRead = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; updatedConversations: number }>('/api/pods/read-all', {
        method: 'POST',
      }),
    onSuccess: () => {
      setUnread({});
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) =>
        old && {
          pods: old.pods.map((p) => ({
            ...p,
            unreadGroupCount: 0,
            dmConversations: (p.dmConversations ?? []).map((dm) => ({ ...dm, unreadCount: 0 })),
          })),
        }
      );
      queryClient.invalidateQueries({ queryKey: ['dms'] });
    },
  });

  const hasCall = (p: PodDetail) =>
    (voice.status === 'connected' && voice.podId === p.podId) ||
    (voicePeersByPod[p.podId]
      ? voicePeersByPod[p.podId].length > 0
      : p.members.some((m) => m.inVoice));

  // Everyone you have written with, plus the person in front of you now and
  // anyone whose first message arrived before the list was fetched.
  const chats = useMemo(() => {
    if (!pod) return [];
    const byPeer = new Map(conversations.map((dm) => [dm.peerId, dm]));
    return members
      .filter((m) => m.peerId !== pod.myPeerId)
      .map((member) => ({ member, dm: byPeer.get(member.peerId) }))
      .filter(
        ({ member, dm }) =>
          dm ||
          member.peerId === activePeerId ||
          (unread[conversationKey(pod.podId, member.peerId)] ?? 0) > 0
      )
      .sort((a, b) => (b.dm?.lastMessageId ?? 0) - (a.dm?.lastMessageId ?? 0));
  }, [activePeerId, conversations, members, pod, unread]);

  return (
    <aside className={s.left} aria-label="Rooms and private chats">
      <div className={s.leftHead}>
        <button
          type="button"
          className={s.logoBtn}
          onClick={() => openRooms(pods.length > 0 ? 'pods' : 'match')}
          aria-label="Canopy: all your rooms"
        >
          <Logo />
        </button>
        {totalUnread > 0 && (
          <button
            type="button"
            className={`${ui.btn} ${ui.small}`}
            disabled={markAllRead.isPending}
            onClick={() => markAllRead.mutate()}
            title="Mark all rooms read"
            aria-label="Mark all rooms read"
          >
            <CheckCheck size={16} aria-hidden="true" />
            <b>Read all</b>
          </button>
        )}
      </div>

      <div className={s.scroll}>
        {pods.map((p) => {
          const current = p.podId === pod?.podId && activePeerId === null;
          const count = roomUnread(p);
          return (
            <button
              key={p.podId}
              type="button"
              className={s.rm}
              style={colorVar(p.myAlias)}
              aria-current={current}
              title={`${roomName(p)}, ${p.code}${p.myMuted ? ' (muted)' : ''}`}
              onClick={() => openConversation(p.podId, null)}
            >
              <i>
                {initials(roomName(p))}
                {hasCall(p) && <span className={s.live} role="img" aria-label="Call on" />}
              </i>
              <span>
                <b>{roomName(p)}</b>
                <small>as {p.myAlias}</small>
              </span>
              {p.myMuted ? (
                <BellOff size={16} className={s.mutedMark} aria-label="Muted" />
              ) : count > 0 ? (
                <em className={ui.badge} aria-label={`${count} new`}>
                  {count}
                </em>
              ) : null}
            </button>
          );
        })}

        {pod && (
          <>
            <h2 className={s.lh}>Private chats</h2>
            {chats.length === 0 && (
              <p className={s.lhint}>
                Press a seat on the right to write to one person alone.
              </p>
            )}
            {chats.map(({ member, dm }) => {
              const current = member.peerId === activePeerId;
              const count = current
                ? 0
                : unreadDm(pod.podId, member.peerId, dm?.unreadCount);
              const calling =
                dmCall.status !== 'idle' &&
                dmCall.podId === pod.podId &&
                dmCall.peerId === member.peerId;
              const line = calling
                ? dmCall.status === 'connected'
                  ? 'In a call with you'
                  : 'Ringing'
                : dm
                  ? `${dm.lastSenderPeerId === pod.myPeerId ? 'You: ' : ''}${dm.lastBody || 'Attachment'}`
                  : member.customStatus || 'Nothing sent yet';
              return (
                <button
                  key={member.peerId}
                  type="button"
                  className={s.pr}
                  style={colorVar(member.alias)}
                  aria-current={current}
                  title={member.alias}
                  onClick={() => openConversation(pod.podId, member.peerId)}
                >
                  <Piece alias={member.alias} size={44} away={!member.online} />
                  <span>
                    <b>{member.alias}</b>
                    <small data-unread={count > 0 ? '' : undefined}>{line}</small>
                  </span>
                  {count > 0 && (
                    <em className={ui.badge} aria-label={`${count} new`}>
                      {count}
                    </em>
                  )}
                </button>
              );
            })}
          </>
        )}
      </div>

      <div className={s.leftFoot}>
        <button
          type="button"
          className={`${ui.btn} ${ui.big} ${ui.blue}`}
          onClick={() => openRooms('match')}
          aria-label="Join another room"
        >
          <Plus size={22} aria-hidden="true" />
          <b>{pods.length > 0 ? 'Join another room' : 'Join a room'}</b>
        </button>
        <button
          type="button"
          className={`${ui.btn} ${ui.small}`}
          aria-pressed={rightPanel === 'bookmarks'}
          aria-label="Saved messages"
          onClick={() => {
            setNavOpen(false);
            setRightPanel(rightPanel === 'bookmarks' ? null : 'bookmarks');
          }}
        >
          <Bookmark size={18} aria-hidden="true" />
          <b>Saved</b>
        </button>
        <button
          type="button"
          className={`${ui.btn} ${ui.small}`}
          aria-label="Your account"
          onClick={() => setAccountOpen(true)}
        >
          <UserRound size={18} aria-hidden="true" />
          <b>Account</b>
        </button>
      </div>
    </aside>
  );
}

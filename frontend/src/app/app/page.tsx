'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { Pin, X } from 'lucide-react';
import { apiFetch, enableTabIsolatedMode, getAuthToken } from '@/lib/api';
import { colorVar } from '@/lib/pieces';
import { authBootstrapReadyAtom, selfUserQueryAtom } from '@/state/authAtoms';
import {
  activeDmPeerByPodAtom,
  activePodIdAtom,
  adminSettingsPodIdAtom,
  commandModalOpenAtom,
  interestModalOpenAtom,
  inviteModalPodIdAtom,
  kickedNoticeAtom,
  mobileNavOpenAtom,
  podsQueryAtom,
  rightPanelAtom,
  unreadByConvoAtom,
  wsConnectedAtom,
} from '@/state/workspaceAtoms';
import { markConversationReadInCaches, usePodWebSocket } from '@/state/wsPodClient';
import { useVoiceActions, useVoiceEngineController } from '@/state/voiceEngine';
import {
  PHONE,
  roomName,
  setPods,
  useMembers,
  useOpenConversation,
  useOpenRooms,
  useRoomCall,
} from '@/state/roomActions';
import { Logo } from '@/components/pieces/Piece';
import { RoomsPanel } from '@/components/workspace/RoomsPanel';
import { SidePanel } from '@/components/workspace/SidePanel';
import { MessageStream } from '@/components/workspace/MessageStream';
import { Composer } from '@/components/workspace/Composer';
import { CallStrip, IncomingCall } from '@/components/workspace/CallCard';
import { RoomsDialog } from '@/components/workspace/RoomsDialog';
import { InviteDialog } from '@/components/workspace/InviteDialog';
import { GroupSettingsDialog } from '@/components/workspace/GroupSettingsDialog';
import { SearchDialog } from '@/components/workspace/SearchDialog';
import { AccountDialog } from '@/components/workspace/AccountDialog';
import {
  conversationKey,
  extractInviteCode,
  type AcceptInviteResponse,
  type PodDetail,
  type PodMember,
  type RichMessage,
  type RightPanelMode,
} from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import s from './workspace.module.css';

export default function WorkspacePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [ready, setReady] = useAtom(authBootstrapReadyAtom);
  const auth = useAtomValue(selfUserQueryAtom);
  const podsQuery = useAtomValue(podsQueryAtom);
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const dmPeers = useAtomValue(activeDmPeerByPodAtom);
  const [panel, setPanel] = useAtom(rightPanelAtom);
  const [navOpen, setNavOpen] = useAtom(mobileNavOpenAtom);
  const setRoomsOpen = useSetAtom(interestModalOpenAtom);
  const [kicked, setKicked] = useAtom(kickedNoticeAtom);
  const [unread, setUnread] = useAtom(unreadByConvoAtom);
  const openRooms = useOpenRooms();
  const [accepting, setAccepting] = useState(false);
  const handledInviteRef = useRef<string | null>(null);
  const offeredRoomsRef = useRef(false);

  const { session, dmSession, incomingDmCall, dmCallNotice, clearDmCallNotice, leaveVoice, endDmCall } =
    useVoiceActions();

  usePodWebSocket();
  useVoiceEngineController();

  // ?fresh=1 keeps this tab's session to itself, and has to run before /api/auth/me does.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const invite = extractInviteCode(params.get('invite') || '');
    if (params.get('fresh') === '1') {
      enableTabIsolatedMode();
      if (!getAuthToken()) {
        const qs = new URLSearchParams({ fresh: '1' });
        if (invite) qs.set('invite', invite);
        router.replace(`/register?${qs}`);
        return;
      }
    }
    if (invite) setAccepting(true);
    setReady(true);
  }, [router, setReady]);

  useEffect(() => {
    if (!ready || !auth.isError || auth.isFetching) return;
    const params = new URLSearchParams(window.location.search);
    const invite = extractInviteCode(params.get('invite') || '');
    const fresh = params.get('fresh') === '1';
    const qs = new URLSearchParams();
    if (fresh) qs.set('fresh', '1');
    if (invite) qs.set('invite', invite);
    router.replace(`${fresh ? '/register' : '/login'}${qs.size ? `?${qs}` : ''}`);
  }, [auth.isError, auth.isFetching, ready, router]);

  // /app?invite=<code> goes straight in.
  useEffect(() => {
    if (!ready || !auth.data?.user) return;
    const params = new URLSearchParams(window.location.search);
    const invite = extractInviteCode(params.get('invite') || '');
    if (!invite) {
      setAccepting(false);
      return;
    }
    if (handledInviteRef.current === invite) return;
    handledInviteRef.current = invite;
    const fresh = params.get('fresh') === '1' ? '?fresh=1' : '';

    apiFetch<AcceptInviteResponse>(`/api/invites/${encodeURIComponent(invite)}/accept`, {
      method: 'POST',
    })
      .then((res) => {
        setPods(queryClient, res.pods);
        setActivePodId(res.pod.podId);
        setRoomsOpen(false);
        router.replace(`/app${fresh}`);
      })
      .catch(() => router.replace(`/invite/${encodeURIComponent(invite)}${fresh}`))
      .finally(() => setAccepting(false));
  }, [auth.data?.user, queryClient, ready, router, setActivePodId, setRoomsOpen]);

  const pods = useMemo(() => podsQuery.data?.pods ?? [], [podsQuery.data]);

  // Being removed from a room also ends its call.
  useEffect(() => {
    if (!podsQuery.isSuccess) return;
    const gone = (id: string | null) => id && !pods.some((p) => p.podId === id);
    if (gone(session.podId)) leaveVoice();
    if (gone(dmSession.podId)) endDmCall();
  }, [dmSession.podId, endDmCall, leaveVoice, pods, podsQuery.isSuccess, session.podId]);

  useEffect(() => {
    if (!podsQuery.isSuccess || accepting) return;
    if (pods.length === 0) {
      if (activePodId !== null) setActivePodId(null);
      if (!offeredRoomsRef.current) {
        offeredRoomsRef.current = true;
        openRooms('match');
      }
      return;
    }
    if (!activePodId || !pods.some((p) => p.podId === activePodId)) {
      setActivePodId(pods[0].podId);
    }
  }, [accepting, activePodId, openRooms, pods, podsQuery.isSuccess, setActivePodId]);

  // Seats are always beside the chat on a wide screen. On a phone they are a tab, so start on the chat.
  useEffect(() => {
    const mql = window.matchMedia(PHONE);
    const onChange = () => {
      if (mql.matches) setPanel((cur) => (cur === 'members' ? null : cur));
    };
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [setPanel]);

  // The news that you were removed is on the chat, so a phone turns to it.
  useEffect(() => {
    if (!kicked) return;
    setNavOpen(false);
    if (window.matchMedia(PHONE).matches) setPanel(null);
  }, [kicked, setNavOpen, setPanel]);

  const pod = pods.find((p) => p.podId === activePodId) ?? null;
  const members = useMembers(pod);
  const savedPeerId = pod ? (dmPeers[pod.podId] ?? null) : null;
  const peer =
    (savedPeerId && savedPeerId !== pod?.myPeerId
      ? members.find((m) => m.peerId === savedPeerId)
      : null) ?? null;
  const peerId = peer?.peerId ?? null;
  const podId = pod?.podId ?? null;

  useEffect(() => {
    if (!podId) return;
    const key = conversationKey(podId, peerId);
    setUnread((prev) => (prev[key] === 0 ? prev : { ...prev, [key]: 0 }));
    markConversationReadInCaches(queryClient, podId, peerId);
  }, [peerId, podId, queryClient, setUnread]);

  const aliases = useMemo(() => members.map((m) => m.alias), [members]);

  // Everything new that is not on screen, for the phone's Rooms tab.
  const waiting = useMemo(
    () =>
      pods.reduce((sum, p) => {
        if (p.myMuted) return sum;
        const here = p.podId === podId;
        const count = (id: string | null, stored: number | undefined) =>
          here && id === peerId ? 0 : (unread[conversationKey(p.podId, id)] ?? stored ?? 0);
        return (
          sum +
          count(null, p.unreadGroupCount) +
          (p.dmConversations ?? []).reduce((n, dm) => n + count(dm.peerId, dm.unreadCount), 0)
        );
      }, 0),
    [peerId, podId, pods, unread]
  );
  const { peers: callPeers } = useRoomCall(pod);

  const user = auth.data?.user ?? null;
  if (!ready || auth.isLoading || !user) {
    return (
      <div className={s.loading}>
        <Logo />
        <p>Putting the pieces out</p>
      </div>
    );
  }

  const view = navOpen ? 'rooms' : panel !== null ? 'people' : 'chat';
  const show = (next: 'rooms' | 'chat' | 'people') => {
    setNavOpen(next === 'rooms');
    setPanel(next === 'people' ? 'members' : null);
  };

  return (
    <div className={s.app} data-view={view} data-empty={pod ? undefined : ''}>
      <RoomsPanel pods={pods} pod={pod} activePeerId={peerId} members={members} />

      <main className={s.mid} style={pod ? undefined : { gridTemplateRows: 'minmax(0, 1fr)' }}>
        {pod ? (
          <>
            <div className={s.top}>
              {peer ? <PersonHead pod={pod} peer={peer} /> : <RoomHead pod={pod} />}
              {!peer && <PinBanner pod={pod} />}
              <CallStrip pod={pod} inDm={peer !== null} />
              {dmCallNotice && <Notice text={dmCallNotice} onClose={clearDmCallNotice} />}
              {kicked && <Notice text={kicked} onClose={() => setKicked(null)} />}
            </div>
            <MessageStream
              key={conversationKey(pod.podId, peerId)}
              pod={pod}
              activePeer={peer}
              knownAliases={aliases}
            />
            <Composer pod={pod} pods={pods} activePeer={peer} members={members} />
          </>
        ) : podsQuery.isLoading ? (
          <div />
        ) : (
          <div className={s.empty}>
            {kicked && <Notice text={kicked} onClose={() => setKicked(null)} />}
            <h1>You are not in a room yet</h1>
            <p>
              Pick a hobby and take a seat. The others get your alias, a colour and an animal, and
              nothing else about you.
            </p>
            <button
              type="button"
              className={`${ui.btn} ${ui.big} ${ui.blue}`}
              onClick={() => openRooms('match')}
            >
              Pick a hobby
            </button>
          </div>
        )}
      </main>

      <SidePanel pod={pod} pods={pods} members={members} activePeerId={peerId} />

      <nav className={s.tabs} aria-label="Views">
        <button type="button" aria-current={view === 'rooms' ? 'page' : undefined} onClick={() => show('rooms')}>
          Rooms
          {waiting > 0 && (
            <em className={ui.badge} aria-label={`${waiting} new`}>
              {waiting}
            </em>
          )}
        </button>
        <button type="button" aria-current={view === 'chat' ? 'page' : undefined} onClick={() => show('chat')}>
          Chat
        </button>
        <button type="button" aria-current={view === 'people' ? 'page' : undefined} onClick={() => show('people')}>
          People
          {(callPeers.length > 0 || Boolean(incomingDmCall)) && (
            <em className={ui.badge} aria-label="Call on">
              {callPeers.length || '!'}
            </em>
          )}
        </button>
      </nav>

      <IncomingCall />
      <RoomsDialog pods={pods} />
      <InviteDialog pods={pods} />
      <GroupSettingsDialog pods={pods} />
      <SearchDialog pods={pods} pod={pod} />
      <AccountDialog user={user} />
    </div>
  );
}

function PinBanner({ pod }: { pod: PodDetail }) {
  const setPanel = useSetAtom(rightPanelAtom);
  const pins = useQuery<{ messages: RichMessage[] }>({
    queryKey: ['pins', pod.podId],
    queryFn: () => apiFetch<{ messages: RichMessage[] }>(`/api/pods/${pod.podId}/pins`),
    staleTime: 15_000,
  });
  const list = pins.data?.messages ?? [];
  if (list.length === 0) return null;
  const top = list[0];
  return (
    <button
      type="button"
      className={s.pinBar}
      onClick={() => setPanel('pins')}
      aria-label={`Pinned by ${top.senderAlias}: ${top.body || 'Attachment'}. View all ${list.length} pinned messages`}
    >
      <Pin size={15} aria-hidden="true" />
      <span>
        <b>{top.senderAlias}</b> {top.body || 'Pinned attachment'}
      </span>
      {list.length > 1 && <em>{list.length}</em>}
    </button>
  );
}

function Notice({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className={s.notice} role="status">
      <span>{text}</span>
      <button type="button" className={ui.icon} style={{ background: 'var(--glass)' }} onClick={onClose} aria-label="Dismiss">
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

function RoomHead({ pod }: { pod: PodDetail }) {
  const [panel, setPanel] = useAtom(rightPanelAtom);
  const connected = useAtomValue(wsConnectedAtom);
  const setSearch = useSetAtom(commandModalOpenAtom);
  const setInvitePod = useSetAtom(inviteModalPodIdAtom);
  const setSettingsPod = useSetAtom(adminSettingsPodIdAtom);
  const toggle = (mode: RightPanelMode) => setPanel(panel === mode ? null : mode);
  const proRoom = pod.governanceMode === 'ADMIN';

  return (
    <header className={s.head}>
      <h1 title={roomName(pod)}>{roomName(pod)}</h1>
      {!proRoom && (
        <button type="button" className={s.tab} aria-pressed={panel === 'votes'} onClick={() => toggle('votes')}>
          Votes{pod.openProposalsCount > 0 ? ` ${pod.openProposalsCount}` : ''}
        </button>
      )}
      <button type="button" className={s.tab} aria-pressed={panel === 'pins'} onClick={() => toggle('pins')}>
        Pins
      </button>
      <button type="button" className={s.tab} title="Ctrl K or ⌘ K" onClick={() => setSearch(true)}>
        Search
      </button>
      <button type="button" className={s.tab} onClick={() => setInvitePod(pod.podId)}>
        Invite
      </button>
      {proRoom && pod.myRole !== 'MEMBER' && (
        <button type="button" className={s.tab} onClick={() => setSettingsPod(pod.podId)}>
          Manage
        </button>
      )}
      <code>{connected ? pod.code : 'Reconnecting'}</code>
    </header>
  );
}

function PersonHead({ pod, peer }: { pod: PodDetail; peer: PodMember }) {
  const openConversation = useOpenConversation();
  const unread = useAtomValue(unreadByConvoAtom);
  const { dmSession, startDmCall, endDmCall } = useVoiceActions();
  const calling =
    dmSession.status !== 'idle' &&
    dmSession.podId === pod.podId &&
    dmSession.peerId === peer.peerId;
  const roomNew = unread[conversationKey(pod.podId, null)] ?? pod.unreadGroupCount ?? 0;

  return (
    <header className={s.headDm} style={colorVar(peer.alias)}>
      <div>
        <h1>{peer.alias}</h1>
        <p>
          {peer.customStatus && `${peer.customStatus}. `}
          Only the two of you can read this
        </p>
      </div>
      <button
        type="button"
        className={`${ui.btn} ${ui.ink}`}
        data-calling={calling ? '' : undefined}
        onClick={() =>
          calling
            ? endDmCall()
            : startDmCall(pod.podId, peer.peerId, peer.alias, peer.color)
        }
      >
        {!calling ? 'Call' : dmSession.status === 'connected' ? 'Hang up' : 'Cancel'}
      </button>
      <button
        type="button"
        className={`${ui.btn} ${ui.glass} ${s.back}`}
        onClick={() => openConversation(pod.podId, null)}
      >
        <span>
          Back<span> to {roomName(pod)}</span>
        </span>
        {roomNew > 0 && <em className={ui.badge}>{roomNew}</em>}
      </button>
    </header>
  );
}

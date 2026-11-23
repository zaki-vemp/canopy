'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  ArrowLeft,
  AudioLines,
  Bookmark,
  Compass,
  Crown,
  HeadphoneOff,
  Headphones,
  Info,
  Layers,
  Lock,
  Menu,
  MessageSquare,
  MessagesSquare,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Pin,
  Radio,
  Scale,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Sliders,
  Users,
  X,
} from 'lucide-react';
import { apiFetch, enableTabIsolatedMode, getAuthToken } from '@/lib/api';
import {
  authBootstrapReadyAtom,
  selfUserQueryAtom,
} from '@/state/authAtoms';
import {
  accountDrawerOpenAtom,
  activeDmPeerByPodAtom,
  activePodIdAtom,
  adminSettingsPodIdAtom,
  commandModalOpenAtom,
  interestModalOpenAtom,
  interestModalTabAtom,
  inviteModalPodIdAtom,
  kickedNoticeAtom,
  mobileNavOpenAtom,
  mobileVoiceSheetOpenAtom,
  podsQueryAtom,
  presenceByPodAtom,
  rightPanelAtom,
  unreadByConvoAtom,
  voicePeersByPodAtom,
  wsConnectedAtom,
} from '@/state/workspaceAtoms';
import { usePodWebSocket } from '@/state/wsPodClient';
import {
  remoteSpeakingMapAtom,
  useVoiceActions,
  useVoiceEngineController,
} from '@/state/voiceEngine';
import { PodServerRail } from '@/components/workspace/PodServerRail';
import { PodChannelSidebar } from '@/components/workspace/PodChannelSidebar';
import { MessageStream } from '@/components/workspace/MessageStream';
import { RichComposer } from '@/components/workspace/RichComposer';
import { RightDrawer } from '@/components/workspace/RightDrawer';
import { InterestMatchModal } from '@/components/workspace/InterestMatchModal';
import { PodInviteModal } from '@/components/workspace/PodInviteModal';
import { AdminPodSettingsModal } from '@/components/workspace/AdminPodSettingsModal';
import { CommandSearchModal } from '@/components/workspace/CommandSearchModal';
import { AccountDrawer } from '@/components/workspace/AccountDrawer';
import { aliasInitials, safeAvatarColor } from '@/components/workspace/markdown';
import {
  conversationKey,
  extractInviteCode,
  type AcceptInviteResponse,
  type PodDetail,
  type VoicePeer,
} from '@/types/canopy';
import styles from './workspace.module.css';

function WorkspaceAppInner() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [bootstrapReady, setBootstrapReady] = useAtom(authBootstrapReadyAtom);
  const authQuery = useAtomValue(selfUserQueryAtom);
  const podsQuery = useAtomValue(podsQueryAtom);

  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const [dmPeerMap, setDmPeerMap] = useAtom(activeDmPeerByPodAtom);
  const [rightPanel, setRightPanel] = useAtom(rightPanelAtom);
  const [mobileNavOpen, setMobileNavOpen] = useAtom(mobileNavOpenAtom);
  const [mobileVoiceOpen, setMobileVoiceOpen] = useAtom(
    mobileVoiceSheetOpenAtom
  );
  const [interestOpen, setInterestOpen] = useAtom(interestModalOpenAtom);
  const setInterestTab = useSetAtom(interestModalTabAtom);
  const [inviteModalPodId, setInviteModalPodId] = useAtom(inviteModalPodIdAtom);
  const [adminSettingsPodId, setAdminSettingsPodId] = useAtom(
    adminSettingsPodIdAtom
  );
  const [kickedNotice, setKickedNotice] = useAtom(kickedNoticeAtom);
  const setCommandOpen = useSetAtom(commandModalOpenAtom);
  const [accountOpen, setAccountOpen] = useAtom(accountDrawerOpenAtom);
  const [unreadMap, setUnreadMap] = useAtom(unreadByConvoAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);
  const remoteSpeakingMap = useAtomValue(remoteSpeakingMapAtom);

  const [pendingInviteAccept, setPendingInviteAccept] = useState(false);
  const [openVolPeerId, setOpenVolPeerId] = useState<string | null>(null);
  const handledUrlInviteRef = useRef<string | null>(null);

  const {
    session: voiceSession,
    peerVolumes,
    joinVoice,
    leaveVoice,
    toggleMute,
    toggleDeafen,
    toggleTestTone,
    setPeerVolume,
  } = useVoiceActions();

  // Close right drawer by default on mobile (<= 900px) so chat is never covered on load
  useEffect(() => {
    if (window.innerWidth <= 900) {
      setRightPanel(null);
    }
    const mql = window.matchMedia('(max-width: 900px)');
    const onViewportChange = (ev: MediaQueryListEvent) => {
      if (ev.matches) {
        setRightPanel((curr) => (curr === 'members' ? null : curr));
      }
    };
    mql.addEventListener('change', onViewportChange);
    return () => mql.removeEventListener('change', onViewportChange);
  }, [setRightPanel]);

  useEffect(() => {
    setOpenVolPeerId(null);
  }, [activePodId]);

  const presenceByPod = useAtomValue(presenceByPodAtom);
  const wsConnected = useAtomValue(wsConnectedAtom);

  const autoOpenedZeroPodsRef = useRef(false);

  // Activate Pod WebSocket + WebRTC P2P Mesh Engine
  usePodWebSocket();
  useVoiceEngineController();

  // Bootstrap multi-tab ?fresh=1 check before firing GET /api/auth/me
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wantsFresh = params.get('fresh') === '1';
    const urlInvite = extractInviteCode(params.get('invite') || '');
    if (wantsFresh) {
      enableTabIsolatedMode();
      if (!getAuthToken()) {
        const regQs = new URLSearchParams({ fresh: '1' });
        if (urlInvite) regQs.set('invite', urlInvite);
        router.replace(`/register?${regQs.toString()}`);
        return;
      }
    }
    if (urlInvite) {
      setPendingInviteAccept(true);
    }
    setBootstrapReady(true);
  }, [router, setBootstrapReady]);

  // Redirect cleanly on 401 / unauthenticated
  useEffect(() => {
    if (!bootstrapReady) return;
    if (authQuery.isError && !authQuery.isFetching) {
      const params = new URLSearchParams(window.location.search);
      const urlInvite = extractInviteCode(params.get('invite') || '');
      if (params.get('fresh') === '1') {
        const regQs = new URLSearchParams({ fresh: '1' });
        if (urlInvite) regQs.set('invite', urlInvite);
        router.replace(`/register?${regQs.toString()}`);
      } else {
        router.replace(
          urlInvite
            ? `/login?invite=${encodeURIComponent(urlInvite)}`
            : '/login'
        );
      }
    }
  }, [authQuery.isError, authQuery.isFetching, bootstrapReady, router]);

  // Auto-accept ?invite=<code> when opening /app?invite=<code>
  useEffect(() => {
    if (!bootstrapReady || !authQuery.data?.user) return;
    const params = new URLSearchParams(window.location.search);
    const urlInvite = extractInviteCode(params.get('invite') || '');
    if (!urlInvite) {
      setPendingInviteAccept(false);
      return;
    }
    if (handledUrlInviteRef.current === urlInvite) return;
    handledUrlInviteRef.current = urlInvite;
    const wantsFresh = params.get('fresh') === '1';

    apiFetch<AcceptInviteResponse>(
      `/api/invites/${encodeURIComponent(urlInvite)}/accept`,
      { method: 'POST' }
    )
      .then((res) => {
        queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], {
          pods: res.pods,
        });
        queryClient.invalidateQueries({ queryKey: ['interests'] });
        setActivePodId(res.pod.podId);
        setInterestOpen(false);
        setPendingInviteAccept(false);
        router.replace(wantsFresh ? '/app?fresh=1' : '/app');
      })
      .catch(() => {
        setPendingInviteAccept(false);
        router.replace(
          `/invite/${encodeURIComponent(urlInvite)}${
            wantsFresh ? '?fresh=1' : ''
          }`
        );
      });
  }, [
    authQuery.data?.user,
    bootstrapReady,
    queryClient,
    router,
    setActivePodId,
    setInterestOpen,
  ]);

  const pods = useMemo(() => podsQuery.data?.pods ?? [], [podsQuery.data]);

  // Tear down voice if kicked/removed from the pod hosting the active voice call
  useEffect(() => {
    if (
      podsQuery.isSuccess &&
      voiceSession.podId &&
      !pods.some((p) => p.podId === voiceSession.podId)
    ) {
      leaveVoice();
    }
  }, [leaveVoice, pods, podsQuery.isSuccess, voiceSession.podId]);

  // Ensure activePodId points to a valid matched pod; auto-open InterestModal when 0 pods
  useEffect(() => {
    if (!podsQuery.isSuccess || pendingInviteAccept) return;
    if (pods.length === 0) {
      if (activePodId !== null) setActivePodId(null);
      if (!autoOpenedZeroPodsRef.current) {
        autoOpenedZeroPodsRef.current = true;
        setInterestTab('match');
        setInterestOpen(true);
      }
      return;
    }
    autoOpenedZeroPodsRef.current = false;
    if (!activePodId || !pods.some((p) => p.podId === activePodId)) {
      setActivePodId(pods[0].podId);
    }
  }, [
    activePodId,
    pendingInviteAccept,
    pods,
    podsQuery.isSuccess,
    setActivePodId,
    setInterestOpen,
    setInterestTab,
  ]);

  const activePod = useMemo(
    () => pods.find((p) => p.podId === activePodId) ?? null,
    [activePodId, pods]
  );

  const liveMembers = useMemo(() => {
    if (!activePod) return [];
    return presenceByPod[activePod.podId]?.members ?? activePod.members;
  }, [activePod, presenceByPod]);

  const activePeer = useMemo(() => {
    if (!activePod) return null;
    const savedPeerId = dmPeerMap[activePod.podId] ?? null;
    if (!savedPeerId || savedPeerId === activePod.myPeerId) return null;
    return liveMembers.find((m) => m.peerId === savedPeerId) ?? null;
  }, [activePod, dmPeerMap, liveMembers]);

  const activePeerId = activePeer?.peerId ?? null;

  // Clear unread counter when viewing the active conversation
  useEffect(() => {
    if (!activePod) return;
    const key = conversationKey(activePod.podId, activePeerId);
    if (unreadMap[key]) {
      const copy = { ...unreadMap };
      delete copy[key];
      setUnreadMap(copy);
    }
  }, [activePeerId, activePod, setUnreadMap, unreadMap]);

  const knownAliases = useMemo(
    () => liveMembers.map((m) => m.alias),
    [liveMembers]
  );

  const totalUnreadInPod = useMemo(() => {
    if (!activePod) return 0;
    const prefix = `${activePod.podId}:`;
    let sum = 0;
    for (const [k, count] of Object.entries(unreadMap)) {
      if (k.startsWith(prefix)) {
        sum += count || 0;
      }
    }
    return sum;
  }, [activePod, unreadMap]);

  const groupUnreadCount = useMemo(() => {
    if (!activePod) return 0;
    return unreadMap[conversationKey(activePod.podId, null)] || 0;
  }, [activePod, unreadMap]);

  const selfUser = authQuery.data?.user ?? null;

  if (!bootstrapReady || authQuery.isLoading || !selfUser) {
    return (
      <div
        style={{
          height: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#ffffff',
          color: '#232323',
          fontFamily: 'var(--m-font-mono)',
          fontSize: 13,
        }}
      >
        Loading Canopy workspace...
      </div>
    );
  }

  const voiceActive = voiceSession.status !== 'idle';
  const connectedToThisPodCall =
    Boolean(activePod) &&
    voiceActive &&
    voiceSession.podId === activePod?.podId;

  const rawVoicePeers = activePod ? voicePeersByPod[activePod.podId] || [] : [];
  const voicePeers: VoicePeer[] = [...rawVoicePeers];
  if (
    activePod &&
    connectedToThisPodCall &&
    voiceSession.status === 'connected' &&
    !voicePeers.some((p) => p.peerId === activePod.myPeerId)
  ) {
    voicePeers.unshift({
      peerId: activePod.myPeerId,
      alias: activePod.myAlias,
      color: activePod.myColor,
      muted: voiceSession.muted,
      deafened: voiceSession.deafened,
      speaking: voiceSession.selfSpeaking,
    });
  }

  const chatTabFocused =
    !mobileNavOpen &&
    rightPanel === null &&
    !mobileVoiceOpen &&
    !interestOpen &&
    !accountOpen &&
    !inviteModalPodId &&
    !adminSettingsPodId;

  const isAdminPod = activePod?.governanceMode === 'ADMIN';
  const canManageAdminPod =
    isAdminPod &&
    (activePod?.myRole === 'OWNER' || activePod?.myRole === 'ADMIN');
  const podDisplayTitle = activePod
    ? activePod.title || `#${activePod.code}`
    : '';

  const selectConversation = (podId: string, peerId: string | null) => {
    setDmPeerMap({ ...dmPeerMap, [podId]: peerId });
    const key = conversationKey(podId, peerId);
    if (unreadMap[key]) {
      const copy = { ...unreadMap };
      delete copy[key];
      setUnreadMap(copy);
    }
  };

  const activePeerInCall = Boolean(
    activePeer &&
      (activePeer.inVoice ||
        voicePeers.some((vp) => vp.peerId === activePeer.peerId))
  );

  return (
    <div className={styles.shell}>
      {mobileNavOpen && (
        <div
          className={styles.mobileBackdrop}
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}

      {rightPanel !== null && (
        <div
          className={styles.rightDrawerBackdrop}
          onClick={() => setRightPanel(null)}
          aria-hidden="true"
        />
      )}

      <div
        className={`${styles.leftCluster} ${
          mobileNavOpen ? styles.leftClusterOpen : ''
        }`}
      >
        <PodServerRail pods={pods} />
        <PodChannelSidebar
          pod={activePod}
          allPods={pods}
          activePeerId={activePeerId}
          members={liveMembers}
        />
      </div>

      <main className={styles.mainStage}>
        <header className={styles.chatHeader}>
          <div className={styles.chatHeaderLeft}>
            <button
              type="button"
              className={styles.mobileMenuBtn}
              onClick={() => {
                setRightPanel(null);
                setMobileNavOpen((v) => !v);
              }}
              aria-label="Toggle conversations drawer"
            >
              <Menu size={19} />
            </button>

            {activePod ? (
              activePeer ? (
                /* 1:1 PRIVATE CHAT HEADER */
                <>
                  <button
                    type="button"
                    className={styles.backToGroupBtn}
                    onClick={() => selectConversation(activePod.podId, null)}
                    aria-label="Back to Pod Group Chat"
                    title="Return to Pod Group Chat"
                  >
                    <ArrowLeft size={15} />
                    <span>Group</span>
                    {groupUnreadCount > 0 && (
                      <span className={styles.unreadBadge}>
                        {groupUnreadCount}
                      </span>
                    )}
                  </button>

                  <div className={styles.dmHeaderIdentity}>
                    <span className={styles.dmHeaderAvatarWrap}>
                      <span
                        className={styles.dmHeaderAvatar}
                        style={{
                          background: safeAvatarColor(
                            activePeer.color,
                            activePeer.alias
                          ),
                        }}
                      >
                        {aliasInitials(activePeer.alias)}
                      </span>
                      <span
                        className={`${styles.convoPresenceDot} ${
                          activePeer.online
                            ? styles.convoPresenceOnline
                            : styles.convoPresenceOffline
                        }`}
                        aria-hidden="true"
                      />
                    </span>

                    <div className={styles.dmHeaderTextCol}>
                      <h1 className={styles.chatChannelTitle}>
                        <span className={styles.chatChannelTitleText}>
                          {activePeer.alias}
                        </span>
                        {activePeer.role === 'OWNER' && (
                          <span className={styles.rolePillOwner}>OWNER</span>
                        )}
                        {activePeer.role === 'ADMIN' && (
                          <span className={styles.rolePillAdmin}>ADMIN</span>
                        )}
                      </h1>
                      <span className={styles.dmStatusSubline}>
                        {activePeerInCall
                          ? 'In Pod Audio Call'
                          : activePeer.online
                            ? 'Online'
                            : 'Offline'}
                        {activePeer.customStatus
                          ? ` · ${activePeer.customStatus}`
                          : ''}
                      </span>
                    </div>
                  </div>

                  <span className={styles.dmPrivacyPill}>
                    <Lock size={11} />
                    <span>
                      Private 1:1 · Only you &amp; {activePeer.alias} can see
                      this
                    </span>
                  </span>
                </>
              ) : (
                /* POD GROUP CHAT HEADER */
                <>
                  <h1 className={styles.chatChannelTitle}>
                    <Users
                      size={17}
                      color="#1f6b3a"
                      style={{ flexShrink: 0 }}
                    />
                    <span className={styles.chatChannelTitleText}>
                      {podDisplayTitle}
                    </span>
                  </h1>

                  <button
                    type="button"
                    className={styles.headerPodChip}
                    onClick={() => {
                      setInterestTab(pods.length > 0 ? 'pods' : 'match');
                      setInterestOpen(true);
                    }}
                    title={`Group Chat · ${liveMembers.length}/${activePod.maxMembers} seats (tap to switch pods)`}
                    aria-label={`Group Chat, ${liveMembers.length} of ${activePod.maxMembers} seats. Tap to switch pods.`}
                  >
                    <span>
                      Group Chat · {liveMembers.length}/{activePod.maxMembers}
                    </span>
                  </button>

                  {isAdminPod ? (
                    <span className={styles.headerGovPill}>
                      <Crown size={11} />
                      <span>
                        Canopy Pro ·{' '}
                        {activePod.isPublicized ? 'Publicized' : 'Private'}
                      </span>
                    </span>
                  ) : (
                    <span className={styles.headerGovPill}>
                      <Scale size={11} />
                      <span>Democratic</span>
                    </span>
                  )}

                  {activePod.description && (
                    <span className={styles.chatTopic}>
                      {activePod.description}
                    </span>
                  )}
                </>
              )
            ) : (
              <h1 className={styles.chatChannelTitle}>
                <span className={styles.chatChannelTitleText}>
                  Canopy 25-Member Blind Pods
                </span>
              </h1>
            )}
          </div>

          <div className={styles.chatHeaderActions}>
            {activePod && (
              <span
                className={styles.wsLiveBadge}
                title={
                  wsConnected
                    ? 'Real-time WebSocket connected'
                    : 'Reconnecting WebSocket...'
                }
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: wsConnected ? '#a1ffcb' : '#d0d5dd',
                    border: '1px solid rgba(31,107,58,0.45)',
                  }}
                />
                <span>{wsConnected ? 'LIVE' : 'SYNC'}</span>
              </span>
            )}

            {/* Join Call / In Call Button */}
            {activePod && (!activePeer || connectedToThisPodCall || voicePeers.length > 0) && (
              <button
                type="button"
                className={`${styles.headerCallBtn} ${
                  connectedToThisPodCall
                    ? styles.headerCallBtnConnected
                    : voicePeers.length > 0
                      ? styles.headerCallBtnLive
                      : ''
                }`}
                onClick={() => {
                  if (connectedToThisPodCall) {
                    if (window.innerWidth <= 900) {
                      setMobileVoiceOpen(true);
                    }
                  } else {
                    joinVoice(activePod.podId, podDisplayTitle);
                  }
                }}
                aria-label={
                  connectedToThisPodCall
                    ? `In Call (${voicePeers.length})`
                    : voicePeers.length > 0
                      ? `Join Pod Audio Call (${voicePeers.length} in call)`
                      : 'Join Pod Audio Call'
                }
                title={
                  connectedToThisPodCall
                    ? 'Active Pod Audio Call'
                    : 'Start or join Pod Audio Call (WebRTC P2P Opus)'
                }
              >
                <PhoneCall size={15} />
                <span className={styles.headerBtnLabel}>
                  {connectedToThisPodCall || voicePeers.length > 0
                    ? `In Call (${voicePeers.length})`
                    : 'Join Call'}
                </span>
              </button>
            )}

            {activePod && !activePeer && !isAdminPod && (
              <button
                type="button"
                className={`${styles.headerBtn} ${
                  rightPanel === 'votes' ? styles.headerBtnActive : ''
                }`}
                onClick={() =>
                  setRightPanel(rightPanel === 'votes' ? null : 'votes')
                }
                aria-label={`Pod governance votes (${activePod.openProposalsCount || 0} open)`}
                title="Democratic Pod Votes (YES > NO)"
              >
                <Scale size={16} />
                <span className={styles.headerBtnLabel}>
                  Votes ({activePod.openProposalsCount || 0})
                </span>
              </button>
            )}

            {activePod && !activePeer && canManageAdminPod && (
              <button
                type="button"
                className={`${styles.headerBtn} ${
                  adminSettingsPodId === activePod.podId
                    ? styles.headerBtnActive
                    : ''
                }`}
                onClick={() => setAdminSettingsPodId(activePod.podId)}
                aria-label="Manage custom group settings"
                title="Manage Group Settings"
              >
                <Settings size={16} />
                <span className={styles.headerBtnLabel}>Manage</span>
              </button>
            )}

            {activePod && !activePeer && (
              <button
                type="button"
                className={`${styles.headerBtn} ${
                  inviteModalPodId === activePod.podId
                    ? styles.headerBtnActive
                    : ''
                }`}
                onClick={() => setInviteModalPodId(activePod.podId)}
                aria-label={`Share invite link for pod #${activePod.code}`}
                title={`Invite / Share #${activePod.code}`}
              >
                <Share2 size={16} />
                <span className={styles.headerBtnLabel}>Share</span>
              </button>
            )}

            <button
              type="button"
              className={styles.headerBtn}
              onClick={() => setCommandOpen(true)}
              aria-label="Search chats and messages (Cmd+K)"
            >
              <Search size={16} />
              <span className={styles.headerBtnLabel}>Search</span>
              <kbd className={styles.kbdHint}>⌘K</kbd>
            </button>

            {activePod && !activePeer && (
              <button
                type="button"
                className={`${styles.headerBtn} ${styles.headerBookmarkBtn} ${
                  rightPanel === 'pins' ? styles.headerBtnActive : ''
                }`}
                onClick={() =>
                  setRightPanel(rightPanel === 'pins' ? null : 'pins')
                }
                aria-label="Pinned messages"
                title="Pinned messages"
              >
                <Pin size={16} />
              </button>
            )}

            <button
              type="button"
              className={`${styles.headerBtn} ${styles.headerBookmarkBtn} ${
                rightPanel === 'bookmarks' ? styles.headerBtnActive : ''
              }`}
              onClick={() =>
                setRightPanel(rightPanel === 'bookmarks' ? null : 'bookmarks')
              }
              aria-label="Saved messages"
              title="Saved messages"
            >
              <Bookmark size={16} />
            </button>

            <button
              type="button"
              className={`${styles.headerBtn} ${
                rightPanel === 'members' ? styles.headerBtnActive : ''
              }`}
              onClick={() =>
                setRightPanel(rightPanel === 'members' ? null : 'members')
              }
              aria-label="Toggle pod info and members"
              title={activePeer ? 'Pod Info & Members' : 'Info / Members'}
            >
              {activePeer ? <Info size={16} /> : <Users size={16} />}
              <span className={styles.headerBtnLabel}>
                {activePeer ? 'Info' : liveMembers.length}
              </span>
            </button>
          </div>
        </header>

        {/* Sleek Compact Active-Call Bar Directly Under Header */}
        {activePod && connectedToThisPodCall && (
          <div
            className={styles.activeCallBar}
            role="region"
            aria-label="Active Pod Audio Call controls"
          >
            <div className={styles.activeCallLeft}>
              <span className={styles.activeCallBadge}>
                <Radio size={13} />
                <span>
                  {voiceSession.status === 'connecting'
                    ? 'Connecting Call...'
                    : `Pod Call (${voicePeers.length})`}
                </span>
              </span>

              <div className={styles.activeCallPeersRow}>
                {voicePeers.map((peer) => {
                  const isSelf = peer.peerId === activePod.myPeerId;
                  const speaking = isSelf
                    ? voiceSession.selfSpeaking || peer.speaking
                    : Boolean(peer.speaking || remoteSpeakingMap[peer.peerId]);
                  const volPct = Math.round(
                    (peerVolumes[peer.peerId] ?? 1) * 100
                  );

                  return (
                    <div key={peer.peerId} className={styles.activeCallPeerWrap}>
                      <button
                        type="button"
                        className={`${styles.activeCallPeerChip} ${
                          speaking ? styles.activeCallPeerChipSpeaking : ''
                        }`}
                        onClick={() => {
                          if (!isSelf) {
                            setOpenVolPeerId((cur) =>
                              cur === peer.peerId ? null : peer.peerId
                            );
                          }
                        }}
                        title={
                          isSelf
                            ? `${peer.alias} (you)`
                            : `Adjust volume for ${peer.alias} (${volPct}%)`
                        }
                      >
                        <span
                          className={`${styles.voiceAvatar} ${
                            speaking ? styles.voiceAvatarSpeaking : ''
                          }`}
                          style={{
                            width: 22,
                            height: 22,
                            fontSize: 9.5,
                            background: safeAvatarColor(peer.color, peer.alias),
                          }}
                        >
                          {aliasInitials(peer.alias)}
                        </span>
                        <span>
                          {peer.alias}
                          {isSelf ? ' (you)' : ''}
                        </span>
                        {peer.muted && <MicOff size={12} color="#fca5a5" />}
                        {peer.deafened && (
                          <HeadphoneOff size={12} color="#fca5a5" />
                        )}
                        {!isSelf && <Sliders size={11} />}
                      </button>

                      {!isSelf && openVolPeerId === peer.peerId && (
                        <div className={styles.callVolumePopover}>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              marginBottom: 4,
                              color: '#232323',
                            }}
                          >
                            <span>{peer.alias}</span>
                            <strong>{volPct}%</strong>
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={150}
                            step={5}
                            value={volPct}
                            onChange={(e) =>
                              setPeerVolume(
                                peer.peerId,
                                Number(e.target.value) / 100
                              )
                            }
                            className={styles.volumeSlider}
                            aria-label={`${peer.alias} volume percentage`}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {voiceSession.fallbackBanner && (
                <span className={styles.activeCallSynthTag}>
                  {voiceSession.fallbackBanner}
                </span>
              )}
            </div>

            <div className={styles.activeCallControls}>
              <button
                type="button"
                className={`${styles.callBarBtn} ${
                  voiceSession.muted ? styles.callBarBtnActive : ''
                }`}
                onClick={toggleMute}
                aria-pressed={voiceSession.muted}
                aria-label={
                  voiceSession.muted ? 'Unmute microphone' : 'Mute microphone'
                }
              >
                {voiceSession.muted ? <MicOff size={15} /> : <Mic size={15} />}
                <span className={styles.callBarBtnLabel}>
                  {voiceSession.muted ? 'Unmute' : 'Mute'}
                </span>
              </button>

              <button
                type="button"
                className={`${styles.callBarBtn} ${
                  voiceSession.deafened ? styles.callBarBtnActive : ''
                }`}
                onClick={toggleDeafen}
                aria-pressed={voiceSession.deafened}
                aria-label={
                  voiceSession.deafened ? 'Undeafen audio' : 'Deafen audio'
                }
              >
                {voiceSession.deafened ? (
                  <HeadphoneOff size={15} />
                ) : (
                  <Headphones size={15} />
                )}
                <span className={styles.callBarBtnLabel}>
                  {voiceSession.deafened ? 'Deaf' : 'Deafen'}
                </span>
              </button>

              <button
                type="button"
                className={`${styles.callBarBtn} ${
                  voiceSession.testToneActive ? styles.callBarBtnActive : ''
                }`}
                onClick={toggleTestTone}
                aria-pressed={voiceSession.testToneActive}
                aria-label="Toggle synth test tone"
                title="Toggle 240Hz/360Hz synth test tone"
              >
                <AudioLines size={15} />
                <span className={styles.callBarBtnLabel}>Test Tone</span>
              </button>

              <button
                type="button"
                className={`${styles.callBarBtn} ${styles.callBarBtnHangup}`}
                onClick={leaveVoice}
                aria-label="Hang up Pod Audio Call"
              >
                <PhoneOff size={15} />
                <span className={styles.callBarBtnLabel}>Hang Up</span>
              </button>
            </div>
          </div>
        )}

        {/* Joinable Live Call Banner when others are in call and you haven't joined yet */}
        {activePod &&
          !connectedToThisPodCall &&
          voicePeers.length > 0 &&
          !activePeer && (
            <div className={styles.joinableCallBanner}>
              <div className={styles.joinableCallInfo}>
                <Radio size={14} color="#1f6b3a" />
                <strong>
                  Pod Audio Call active · {voicePeers.length}{' '}
                  {voicePeers.length === 1 ? 'member' : 'members'} in call:
                </strong>
                <span>{voicePeers.map((p) => p.alias).join(', ')}</span>
              </div>
              <button
                type="button"
                className={styles.podCardPrimaryBtn}
                style={{ minHeight: 40 }}
                onClick={() => joinVoice(activePod.podId, podDisplayTitle)}
              >
                <PhoneCall size={14} />
                <span>Join Call</span>
              </button>
            </div>
          )}

        {kickedNotice && (
          <div className={styles.kickedBanner} role="alert">
            <span>{kickedNotice}</span>
            <button
              type="button"
              className={styles.iconSmallBtn}
              onClick={() => setKickedNotice(null)}
              aria-label="Dismiss removal notice"
            >
              <X size={15} />
            </button>
          </div>
        )}

        {activePod ? (
          <>
            <MessageStream
              pod={activePod}
              activePeer={activePeer}
              knownAliases={knownAliases}
            />
            <RichComposer
              pod={activePod}
              allPods={pods}
              activePeer={activePeer}
              members={liveMembers}
            />
          </>
        ) : (
          <div className={styles.emptyState}>
            <div
              style={{
                width: 60,
                height: 60,
                borderRadius: 16,
                background: '#a1ffcb',
                color: '#164425',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid #1f6b3a',
              }}
            >
              <Compass size={28} />
            </div>
            <h2 style={{ margin: 0, fontSize: 22 }}>
              Match into your first 25-member blind pod
            </h2>
            <p
              style={{
                margin: 0,
                maxWidth: 480,
                color: '#686868',
                fontSize: 14.5,
                lineHeight: 1.5,
              }}
            >
              Pick shared interests to match into 25-member democratic pods
              (Compact 10, Standard 25, or Club 50 seats) with Pod Group Chat,
              private 1:1 member DMs, YES/NO voting, voice notes, and Pod Audio
              Calls — blind to real names, genders, and nationalities.
            </p>
            <button
              type="button"
              className={styles.primaryActionBtn}
              onClick={() => {
                setInterestTab('match');
                setInterestOpen(true);
              }}
            >
              + Choose Interests &amp; Match 25-Seat Pods
            </button>
          </div>
        )}
      </main>

      <RightDrawer pod={activePod} allPods={pods} members={liveMembers} />

      {/* Mobile Pod Audio Call Sheet */}
      {mobileVoiceOpen && (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="Pod Audio Call controls"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMobileVoiceOpen(false);
          }}
        >
          <div className={styles.modalCard} style={{ maxWidth: 460 }}>
            <div className={styles.modalHeader}>
              <div>
                <h2 style={{ margin: 0, fontSize: 17 }}>
                  Pod Audio Call
                  {activePod ? ` · #${activePod.code}` : ''}
                </h2>
                <p
                  style={{
                    margin: '2px 0 0',
                    fontSize: 12,
                    color: '#686868',
                  }}
                >
                  Drop-in WebRTC P2P Opus Mesh voice
                </p>
              </div>
              <button
                type="button"
                className={styles.composerIconBtn}
                onClick={() => setMobileVoiceOpen(false)}
                aria-label="Close audio call sheet"
              >
                <X size={18} />
              </button>
            </div>

            <div
              className={styles.modalBody}
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              {!activePod ? (
                <button
                  type="button"
                  className={styles.primaryActionBtn}
                  onClick={() => {
                    setMobileVoiceOpen(false);
                    setInterestTab('match');
                    setInterestOpen(true);
                  }}
                >
                  + Match into a 25-Member Pod First
                </button>
              ) : connectedToThisPodCall ? (
                <div
                  className={styles.voiceDock}
                  style={{ borderRadius: 12 }}
                  role="region"
                  aria-label="Active audio call controls"
                >
                  <div className={styles.voiceDockStatus}>
                    <Radio size={14} />
                    <span>
                      {voiceSession.status === 'connecting'
                        ? 'Connecting Call...'
                        : `Connected · ${voiceSession.podLabel}`}
                    </span>
                  </div>
                  {voiceSession.fallbackBanner && (
                    <div className={styles.synthBanner}>
                      {voiceSession.fallbackBanner}
                    </div>
                  )}
                  <div className={styles.voiceDockControls}>
                    <button
                      type="button"
                      className={`${styles.voiceCtrlBtn} ${
                        voiceSession.muted ? styles.voiceCtrlBtnActive : ''
                      }`}
                      onClick={toggleMute}
                      aria-pressed={voiceSession.muted}
                    >
                      {voiceSession.muted ? (
                        <MicOff size={16} />
                      ) : (
                        <Mic size={16} />
                      )}
                      <span>{voiceSession.muted ? 'Unmute' : 'Mute'}</span>
                    </button>

                    <button
                      type="button"
                      className={`${styles.voiceCtrlBtn} ${
                        voiceSession.deafened ? styles.voiceCtrlBtnActive : ''
                      }`}
                      onClick={toggleDeafen}
                      aria-pressed={voiceSession.deafened}
                    >
                      {voiceSession.deafened ? (
                        <HeadphoneOff size={16} />
                      ) : (
                        <Headphones size={16} />
                      )}
                      <span>{voiceSession.deafened ? 'Deaf' : 'Deafen'}</span>
                    </button>

                    <button
                      type="button"
                      className={`${styles.voiceCtrlBtn} ${
                        voiceSession.testToneActive
                          ? styles.voiceCtrlBtnActive
                          : ''
                      }`}
                      onClick={toggleTestTone}
                      aria-pressed={voiceSession.testToneActive}
                    >
                      <AudioLines size={16} />
                      <span>Test Tone</span>
                    </button>

                    <button
                      type="button"
                      className={`${styles.voiceCtrlBtn} ${styles.voiceCtrlBtnDanger}`}
                      onClick={leaveVoice}
                    >
                      <PhoneOff size={16} />
                      <span>Hang Up</span>
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.primaryActionBtn}
                  onClick={() => joinVoice(activePod.podId, podDisplayTitle)}
                >
                  <PhoneCall size={16} />
                  <span>
                    {voicePeers.length > 0
                      ? `Join Pod Audio Call (${voicePeers.length} in call)`
                      : 'Start Pod Audio Call'}
                  </span>
                </button>
              )}

              {activePod && voicePeers.length > 0 && (
                <div
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    border: '1px solid rgba(35,35,35,0.13)',
                    background: '#f8f9f8',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  <div className={styles.sectionHeader}>
                    <span>In Call — {voicePeers.length}</span>
                  </div>
                  {voicePeers.map((p) => {
                    const isSelf = p.peerId === activePod.myPeerId;
                    const speaking = isSelf
                      ? voiceSession.selfSpeaking || p.speaking
                      : Boolean(p.speaking || remoteSpeakingMap[p.peerId]);
                    return (
                      <div key={p.peerId} className={styles.voicePeerRow}>
                        <div className={styles.voicePeerIdentity}>
                          <span
                            className={`${styles.voiceAvatar} ${
                              speaking ? styles.voiceAvatarSpeaking : ''
                            }`}
                            style={{
                              background: safeAvatarColor(p.color, p.alias),
                            }}
                          >
                            {aliasInitials(p.alias)}
                          </span>
                          <span style={{ fontWeight: isSelf ? 700 : 600 }}>
                            {p.alias}
                            {isSelf ? ' (you)' : ''}
                          </span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          {p.muted && <MicOff size={14} color="#b42318" />}
                          {p.deafened && (
                            <HeadphoneOff size={14} color="#b42318" />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Docked Mobile Bottom Navigation Bar (<= 900px): Pods, Chats, Chat, Call, Account */}
      <nav
        className={styles.mobileTabBar}
        aria-label="Mobile workspace navigation"
      >
        <button
          type="button"
          className={`${styles.mobileTabBtn} ${
            interestOpen ? styles.mobileTabBtnActive : ''
          }`}
          onClick={() => {
            setMobileNavOpen(false);
            setRightPanel(null);
            setMobileVoiceOpen(false);
            setAccountOpen(false);
            setInviteModalPodId(null);
            setAdminSettingsPodId(null);
            setInterestTab(pods.length > 0 ? 'pods' : 'match');
            setInterestOpen(true);
          }}
          aria-label={`Pods (${pods.length} active)`}
        >
          <span className={styles.mobileTabIconWrap}>
            <Layers size={19} />
            {pods.length > 0 && (
              <span className={styles.mobileTabBadge}>{pods.length}</span>
            )}
          </span>
          <span>Pods</span>
        </button>

        <button
          type="button"
          className={`${styles.mobileTabBtn} ${
            mobileNavOpen ? styles.mobileTabBtnActive : ''
          }`}
          onClick={() => {
            setRightPanel(null);
            setMobileVoiceOpen(false);
            setInterestOpen(false);
            setAccountOpen(false);
            setInviteModalPodId(null);
            setAdminSettingsPodId(null);
            setMobileNavOpen((v) => !v);
          }}
          aria-label="Chats (Group and Member DMs)"
        >
          <span className={styles.mobileTabIconWrap}>
            <MessagesSquare size={19} />
            {totalUnreadInPod > 0 && (
              <span className={styles.mobileTabBadge}>{totalUnreadInPod}</span>
            )}
          </span>
          <span>Chats</span>
        </button>

        <button
          type="button"
          className={`${styles.mobileTabBtn} ${
            chatTabFocused ? styles.mobileTabBtnActive : ''
          }`}
          onClick={() => {
            setMobileNavOpen(false);
            setRightPanel(null);
            setMobileVoiceOpen(false);
            setInterestOpen(false);
            setAccountOpen(false);
            setInviteModalPodId(null);
            setAdminSettingsPodId(null);
          }}
          aria-label="Chat"
        >
          <span className={styles.mobileTabIconWrap}>
            <MessageSquare size={19} />
          </span>
          <span>Chat</span>
        </button>

        <button
          type="button"
          className={`${styles.mobileTabBtn} ${
            mobileVoiceOpen || voiceActive ? styles.mobileTabBtnActive : ''
          }`}
          onClick={() => {
            setMobileNavOpen(false);
            setRightPanel(null);
            setInterestOpen(false);
            setAccountOpen(false);
            setInviteModalPodId(null);
            setAdminSettingsPodId(null);
            setMobileVoiceOpen((v) => !v);
          }}
          aria-label={voiceActive ? 'Call (Connected)' : 'Call'}
        >
          <span className={styles.mobileTabIconWrap}>
            <PhoneCall size={19} />
            {(voiceActive || voicePeers.length > 0) && (
              <span className={styles.mobileVoicePulse} aria-hidden="true" />
            )}
          </span>
          <span>Call</span>
        </button>

        <button
          type="button"
          className={`${styles.mobileTabBtn} ${
            accountOpen ? styles.mobileTabBtnActive : ''
          }`}
          onClick={() => {
            setMobileNavOpen(false);
            setRightPanel(null);
            setMobileVoiceOpen(false);
            setInterestOpen(false);
            setInviteModalPodId(null);
            setAdminSettingsPodId(null);
            setAccountOpen(true);
          }}
          aria-label="Private Account"
        >
          <span className={styles.mobileTabIconWrap}>
            <ShieldCheck size={19} />
          </span>
          <span>Account</span>
        </button>
      </nav>

      <InterestMatchModal currentPods={pods} />
      <PodInviteModal pods={pods} />
      <AdminPodSettingsModal pods={pods} />
      <CommandSearchModal pods={pods} activePod={activePod} />
      <AccountDrawer user={selfUser} />
    </div>
  );
}

export default function WorkspacePage() {
  return <WorkspaceAppInner />;
}

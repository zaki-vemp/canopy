'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  AudioLines,
  Bookmark,
  Compass,
  Crown,
  Hash,
  HeadphoneOff,
  Headphones,
  Layers,
  Menu,
  MessageSquare,
  Mic,
  MicOff,
  PhoneOff,
  Pin,
  Radio,
  Scale,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import { apiFetch, enableTabIsolatedMode, getAuthToken } from '@/lib/api';
import {
  authBootstrapReadyAtom,
  selfUserQueryAtom,
} from '@/state/authAtoms';
import {
  accountDrawerOpenAtom,
  activeChannelIdMapAtom,
  activePodIdAtom,
  activeThreadMessageIdAtom,
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
  unreadByChannelAtom,
  voiceRosterByPodAtom,
  wsConnectedAtom,
} from '@/state/workspaceAtoms';
import { usePodWebSocket } from '@/state/wsPodClient';
import {
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
  extractInviteCode,
  type AcceptInviteResponse,
  type PodDetail,
} from '@/types/canopy';
import styles from './workspace.module.css';

function WorkspaceAppInner() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [bootstrapReady, setBootstrapReady] = useAtom(authBootstrapReadyAtom);
  const authQuery = useAtomValue(selfUserQueryAtom);
  const podsQuery = useAtomValue(podsQueryAtom);

  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const [channelMap, setChannelMap] = useAtom(activeChannelIdMapAtom);
  const [rightPanel, setRightPanel] = useAtom(rightPanelAtom);
  const setActiveThreadId = useSetAtom(activeThreadMessageIdAtom);
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
  const unreadMap = useAtomValue(unreadByChannelAtom);
  const voiceRosterByPod = useAtomValue(voiceRosterByPodAtom);
  const [pendingInviteAccept, setPendingInviteAccept] = useState(false);
  const handledUrlInviteRef = useRef<string | null>(null);

  const {
    session: voiceSession,
    joinVoice,
    leaveVoice,
    toggleMute,
    toggleDeafen,
    toggleTestTone,
  } = useVoiceActions();

  const prevPodIdRef = useRef<string | null>(null);

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
    if (prevPodIdRef.current && prevPodIdRef.current !== activePodId) {
      setActiveThreadId(null);
      setRightPanel((curr) =>
        curr === 'thread'
          ? window.innerWidth <= 900
            ? null
            : 'members'
          : curr
      );
    }
    prevPodIdRef.current = activePodId;
  }, [activePodId, setActiveThreadId, setRightPanel]);

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

  const activeChannel = useMemo(() => {
    if (!activePod) return null;
    const textChannels = activePod.channels.filter((c) => c.kind === 'TEXT');
    const savedId = channelMap[activePod.podId];
    return (
      textChannels.find((c) => c.channelId === savedId) ??
      textChannels[0] ??
      null
    );
  }, [activePod, channelMap]);

  useEffect(() => {
    if (
      activePod &&
      activeChannel &&
      channelMap[activePod.podId] !== activeChannel.channelId
    ) {
      setChannelMap({
        ...channelMap,
        [activePod.podId]: activeChannel.channelId,
      });
    }
  }, [activeChannel, activePod, channelMap, setChannelMap]);

  const liveMembers = useMemo(() => {
    if (!activePod) return [];
    return presenceByPod[activePod.podId]?.members ?? activePod.members;
  }, [activePod, presenceByPod]);

  const knownAliases = useMemo(
    () => liveMembers.map((m) => m.alias),
    [liveMembers]
  );

  const totalUnreadInPod = useMemo(() => {
    if (!activePod) return 0;
    return activePod.channels.reduce(
      (sum, ch) => sum + (unreadMap[ch.channelId] || 0),
      0
    );
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
  const chatTabFocused =
    !mobileNavOpen &&
    rightPanel === null &&
    !mobileVoiceOpen &&
    !interestOpen &&
    !accountOpen &&
    !inviteModalPodId &&
    !adminSettingsPodId;

  const activePodVoiceChannels = activePod
    ? activePod.channels.filter((c) => c.kind === 'VOICE')
    : [];
  const podVoiceRoster = activePod
    ? voiceRosterByPod[activePod.podId] || {}
    : {};

  const isAdminPod = activePod?.governanceMode === 'ADMIN';
  const canManageAdminPod =
    isAdminPod &&
    (activePod?.myRole === 'OWNER' || activePod?.myRole === 'ADMIN');
  const podDisplayTitle = activePod
    ? activePod.title || `#${activePod.code}`
    : '';

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
          activeChannelId={activeChannel?.channelId ?? null}
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
              aria-label="Toggle channels drawer"
            >
              <Menu size={19} />
            </button>

            {activePod && activeChannel ? (
              <>
                <h1 className={styles.chatChannelTitle}>
                  <Hash size={17} style={{ flexShrink: 0 }} />
                  <span className={styles.chatChannelTitleText}>
                    {activeChannel.label}
                  </span>
                </h1>

                <button
                  type="button"
                  className={styles.headerPodChip}
                  onClick={() => {
                    setInterestTab(pods.length > 0 ? 'pods' : 'match');
                    setInterestOpen(true);
                  }}
                  title={`Switch pods · ${podDisplayTitle} (${liveMembers.length}/${activePod.maxMembers})`}
                  aria-label={`Active pod ${podDisplayTitle}, ${liveMembers.length} of ${activePod.maxMembers} seats. Tap to switch pods.`}
                >
                  <span>
                    {podDisplayTitle} · {liveMembers.length}/
                    {activePod.maxMembers}
                  </span>
                </button>

                {isAdminPod ? (
                  <span className={styles.headerGovPill}>
                    <Crown size={11} />
                    <span>
                      👑 {activePod.isPublicized ? 'Publicized' : 'Private'}
                    </span>
                  </span>
                ) : (
                  <span className={styles.headerGovPill}>
                    <Scale size={11} />
                    <span>⚖️ Democratic</span>
                  </span>
                )}

                {activeChannel.topic && (
                  <span className={styles.chatTopic}>
                    {activeChannel.topic}
                  </span>
                )}
              </>
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

            {activePod && !isAdminPod && (
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

            {activePod && canManageAdminPod && (
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
                <span className={styles.headerBtnLabel}>Manage Group</span>
              </button>
            )}

            {activePod && (
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
              aria-label="Search pods, channels, and messages (Cmd+K)"
            >
              <Search size={16} />
              <span className={styles.headerBtnLabel}>Search</span>
              <kbd className={styles.kbdHint}>⌘K</kbd>
            </button>

            <button
              type="button"
              className={`${styles.headerBtn} ${
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

            <button
              type="button"
              className={`${styles.headerBtn} ${styles.headerBookmarkBtn} ${
                rightPanel === 'bookmarks' ? styles.headerBtnActive : ''
              }`}
              onClick={() =>
                setRightPanel(rightPanel === 'bookmarks' ? null : 'bookmarks')
              }
              aria-label="Saved bookmarks"
              title="Saved bookmarks"
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
              aria-label="Toggle anonymous member roster"
              title="Pod Roster"
            >
              <Users size={16} />
              <span className={styles.headerBtnLabel}>
                {liveMembers.length}
              </span>
            </button>
          </div>
        </header>

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

        {activePod && activeChannel ? (
          <>
            <MessageStream
              pod={activePod}
              channel={activeChannel}
              knownAliases={knownAliases}
            />
            <RichComposer
              pod={activePod}
              allPods={pods}
              channel={activeChannel}
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
              (Compact 10, Standard 25, or Club 50 seats) with YES/NO member
              voting, Slack threads, voice notes, and WebRTC voice channels —
              blind to real names, genders, and nationalities.
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

      <RightDrawer
        pod={activePod}
        allPods={pods}
        channel={activeChannel}
        members={liveMembers}
      />

      {/* Mobile Quick Voice Channels & Controls Sheet */}
      {mobileVoiceOpen && (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="Voice channels and controls"
          onClick={(e) => {
            if (e.target === e.currentTarget) setMobileVoiceOpen(false);
          }}
        >
          <div className={styles.modalCard} style={{ maxWidth: 460 }}>
            <div className={styles.modalHeader}>
              <div>
                <h2 style={{ margin: 0, fontSize: 17 }}>
                  Voice Channels
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
                aria-label="Close voice sheet"
              >
                <X size={18} />
              </button>
            </div>

            <div
              className={styles.modalBody}
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              {voiceActive && (
                <div
                  className={styles.voiceDock}
                  style={{ borderRadius: 12 }}
                  role="region"
                  aria-label="Active voice session controls"
                >
                  <div className={styles.voiceDockStatus}>
                    <Radio size={14} />
                    <span>
                      {voiceSession.status === 'connecting'
                        ? 'Connecting Voice...'
                        : `Connected · ${voiceSession.voiceChannelLabel}`}
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
                      <span>Leave</span>
                    </button>
                  </div>
                </div>
              )}

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
              ) : (
                activePodVoiceChannels.map((vch) => {
                  const connectedHere =
                    voiceActive &&
                    voiceSession.podId === activePod.podId &&
                    voiceSession.voiceChannelId === vch.channelId;
                  const peers = podVoiceRoster[vch.channelId] || [];

                  return (
                    <div
                      key={vch.channelId}
                      style={{
                        padding: 12,
                        borderRadius: 12,
                        border: connectedHere
                          ? '1px solid #1f6b3a'
                          : '1px solid rgba(35,35,35,0.13)',
                        background: connectedHere ? '#edfcf3' : '#f8f9f8',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontWeight: 700,
                            fontSize: 14.5,
                          }}
                        >
                          <Volume2 size={17} color="#1f6b3a" />
                          <span>{vch.label}</span>
                        </div>
                        <button
                          type="button"
                          className={
                            connectedHere
                              ? styles.leaveBtn
                              : styles.podCardPrimaryBtn
                          }
                          onClick={() => {
                            if (connectedHere) {
                              leaveVoice();
                            } else {
                              joinVoice(
                                activePod.podId,
                                vch.channelId,
                                vch.label
                              );
                            }
                          }}
                        >
                          {connectedHere ? 'Disconnect' : 'Join Voice'}
                        </button>
                      </div>

                      {peers.length > 0 && (
                        <div
                          style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 6,
                            marginTop: 10,
                          }}
                        >
                          {peers.map((p) => (
                            <span
                              key={p.peerId}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                padding: '4px 8px',
                                borderRadius: 999,
                                background: '#ffffff',
                                border: '1px solid rgba(35,35,35,0.12)',
                                fontSize: 12,
                                fontWeight: 600,
                              }}
                            >
                              <span
                                className={styles.voiceAvatar}
                                style={{
                                  width: 20,
                                  height: 20,
                                  fontSize: 9.5,
                                  background: safeAvatarColor(p.color, p.alias),
                                }}
                              >
                                {aliasInitials(p.alias)}
                              </span>
                              <span>{p.alias}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Docked Mobile Bottom Navigation Bar (<= 900px) */}
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
          aria-label="Channels"
        >
          <span className={styles.mobileTabIconWrap}>
            <Hash size={19} />
            {totalUnreadInPod > 0 && (
              <span className={styles.mobileTabBadge}>{totalUnreadInPod}</span>
            )}
          </span>
          <span>Channels</span>
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
          aria-label={voiceActive ? 'Voice (Connected)' : 'Voice'}
        >
          <span className={styles.mobileTabIconWrap}>
            <Headphones size={19} />
            {voiceActive && (
              <span className={styles.mobileVoicePulse} aria-hidden="true" />
            )}
          </span>
          <span>Voice</span>
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

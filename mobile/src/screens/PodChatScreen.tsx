import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  ApiError,
  createChannel,
  createPodProposal,
  deleteMessage,
  fetchMessages,
  fetchPods,
  leavePod,
  postMessage,
  toggleBookmark,
  togglePin,
  toggleReaction,
  uploadVoiceNoteAttachment,
  votePoll,
  voteProposal,
} from '../api/client';
import type { WsOutboundFrame } from '../types/canopy';
import {
  activeChannelByPodAtom,
  activePodIdAtom,
  activeTabAtom,
  activeThreadParentAtom,
  typingByChannelAtom,
  wsConnectedAtom,
} from '../state/atoms';
import type { PodDetail, RichMessage } from '../types/canopy';
import { PALETTE, TOUCH_MIN, capacityTierBadge } from '../theme/palette';
import { MessageCard } from '../components/MessageCard';
import { ThreadModal } from '../components/ThreadModal';
import { InviteShareModal } from '../components/InviteShareModal';
import { PodGovernanceModal } from '../components/PodGovernanceModal';

const QUICK_EMOJIS = ['🔥', '👍', '😂', '🎯', '❤️'];

const SLASH_CHIPS: ReadonlyArray<{ cmd: string; label: string }> = [
  { cmd: '/invite', label: '/invite' },
  { cmd: '/poll', label: '/poll' },
  { cmd: '/icebreaker', label: '/icebreaker' },
  { cmd: '/shrug', label: '/shrug' },
  { cmd: '/rematch', label: '/rematch' },
];

const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

export function PodChatScreen({
  sendFrame,
}: {
  sendFrame: (frame: WsOutboundFrame) => boolean;
}) {
  const queryClient = useQueryClient();
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const [activeChannelMap, setActiveChannelMap] = useAtom(
    activeChannelByPodAtom
  );
  const [threadParent, setThreadParent] = useAtom(activeThreadParentAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const typingByChannel = useAtomValue(typingByChannelAtom);
  const wsConnected = useAtomValue(wsConnectedAtom);

  const [podSwitcherOpen, setPodSwitcherOpen] = useState(false);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [governanceModalOpen, setGovernanceModalOpen] = useState(false);
  const [newChannelModalOpen, setNewChannelModalOpen] = useState(false);
  const [newChannelLabel, setNewChannelLabel] = useState('');
  const [newChannelTopic, setNewChannelTopic] = useState('');

  const [actionTarget, setActionTarget] = useState<RichMessage | null>(null);
  const [quoteTarget, setQuoteTarget] = useState<RichMessage | null>(null);
  const [draft, setDraft] = useState('');
  const [composerNotice, setComposerNotice] = useState<string | null>(null);

  // Voice Note recording state
  const recordingRef = useRef<Audio.Recording | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordElapsedSec, setRecordElapsedSec] = useState(0);
  const [uploadingVoice, setUploadingVoice] = useState(false);

  // Typing debounce ref
  const typingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const podsQuery = useQuery({
    queryKey: ['pods'],
    queryFn: fetchPods,
  });

  const pods = podsQuery.data?.pods ?? [];
  const activePod: PodDetail | null = useMemo(() => {
    if (pods.length === 0) return null;
    return pods.find((p) => p.podId === activePodId) ?? pods[0];
  }, [pods, activePodId]);

  useEffect(() => {
    if (activePod && activePod.podId !== activePodId) {
      setActivePodId(activePod.podId);
    }
  }, [activePod, activePodId, setActivePodId]);

  const textChannels = useMemo(
    () => (activePod?.channels ?? []).filter((c) => c.kind === 'TEXT'),
    [activePod]
  );

  const activeChannel = useMemo(() => {
    if (!activePod || textChannels.length === 0) return null;
    const savedId = activeChannelMap[activePod.podId];
    return (
      textChannels.find((c) => c.channelId === savedId) ?? textChannels[0]
    );
  }, [activePod, textChannels, activeChannelMap]);

  const podId = activePod?.podId ?? '';
  const channelId = activeChannel?.channelId ?? '';

  const messagesQuery = useInfiniteQuery({
    queryKey: ['messages', podId, channelId],
    queryFn: ({ pageParam }) => fetchMessages(podId, channelId, pageParam, 40),
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.nextBeforeId && lastPage.nextBeforeId > 0
        ? lastPage.nextBeforeId
        : undefined,
    enabled: !!podId && !!channelId,
  });

  const chronologicalMessages = useMemo(() => {
    const pages = messagesQuery.data?.pages ?? [];
    if (pages.length === 0) return [];
    const seen = new Set<number>();
    const combined: RichMessage[] = [];
    for (let i = pages.length - 1; i >= 0; i--) {
      for (const msg of pages[i].messages) {
        if (!seen.has(msg.id)) {
          seen.add(msg.id);
          combined.push(msg);
        }
      }
    }
    return combined;
  }, [messagesQuery.data]);

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
      }
    };
  }, []);

  const postMutation = useMutation({
    mutationFn: (payload: {
      body: string;
      quoteMessageId?: number;
      attachmentIds?: number[];
    }) => postMessage(podId, channelId, payload),
    onSuccess: (res) => {
      setDraft('');
      setQuoteTarget(null);
      setComposerNotice(
        res.commandHandled ? `Updated ${res.commandHandled}` : null
      );
      queryClient.invalidateQueries({
        queryKey: ['messages', podId, channelId],
      });
      if (res.commandHandled === 'status') {
        queryClient.invalidateQueries({ queryKey: ['pods'] });
      }
    },
    onError: (err) => {
      setComposerNotice(
        err instanceof Error ? err.message : 'Could not send message.'
      );
    },
  });

  const reactMutation = useMutation({
    mutationFn: ({
      messageId,
      emoji,
    }: {
      messageId: number;
      emoji: string;
    }) => toggleReaction(messageId, emoji),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['messages', podId, channelId],
      });
    },
  });

  const pinMutation = useMutation({
    mutationFn: async (messageId: number) => {
      try {
        await togglePin(messageId);
        return 'toggled' as const;
      } catch (err) {
        if (
          err instanceof ApiError &&
          err.status === 403 &&
          activePod?.governanceMode !== 'ADMIN'
        ) {
          await createPodProposal(podId, {
            kind: 'PIN_MESSAGE',
            messageId,
          });
          return 'proposed' as const;
        }
        throw err;
      }
    },
    onSuccess: (mode) => {
      if (mode === 'proposed') {
        setComposerNotice('Opened democratic pod vote to pin message.');
        queryClient.invalidateQueries({ queryKey: ['proposals', podId] });
        queryClient.invalidateQueries({ queryKey: ['pods'] });
      }
      queryClient.invalidateQueries({
        queryKey: ['messages', podId, channelId],
      });
      queryClient.invalidateQueries({ queryKey: ['pins', podId] });
    },
    onError: (err) => {
      setComposerNotice(
        err instanceof Error ? err.message : 'Could not update pin.'
      );
    },
  });

  const bookmarkMutation = useMutation({
    mutationFn: (messageId: number) => toggleBookmark(messageId),
    onSuccess: (res) => {
      setComposerNotice(
        res.bookmarked ? 'Saved to bookmarks.' : 'Removed from saved.'
      );
      queryClient.invalidateQueries({
        queryKey: ['messages', podId, channelId],
      });
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (messageId: number) => deleteMessage(messageId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['messages', podId, channelId],
      });
    },
  });

  const voteMutation = useMutation({
    mutationFn: ({
      pollId,
      optionIndex,
    }: {
      pollId: number;
      optionIndex: number;
    }) => votePoll(pollId, optionIndex),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['messages', podId, channelId],
      });
    },
  });

  const voteProposalMutation = useMutation({
    mutationFn: ({
      proposalId,
      vote,
    }: {
      proposalId: number;
      vote: boolean;
    }) => voteProposal(proposalId, vote),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['messages', podId, channelId],
      });
      queryClient.invalidateQueries({ queryKey: ['proposals', podId] });
      queryClient.invalidateQueries({ queryKey: ['pods'] });
    },
    onError: (err) => {
      setComposerNotice(err instanceof Error ? err.message : 'Vote failed.');
    },
  });

  const createChannelMutation = useMutation({
    mutationFn: async () => {
      if (
        activePod?.governanceMode !== 'ADMIN' &&
        (activePod?.memberCount ?? 1) > 1
      ) {
        const res = await createPodProposal(podId, {
          kind: 'ADD_CHANNEL',
          label: newChannelLabel.trim(),
          topic: newChannelTopic.trim(),
          channelKind: 'TEXT',
        });
        return { kind: 'proposal' as const, proposal: res.proposal };
      }
      const res = await createChannel(podId, {
        label: newChannelLabel.trim(),
        topic: newChannelTopic.trim(),
        kind: 'TEXT',
      });
      return { kind: 'created' as const, channel: res.channel };
    },
    onSuccess: (res) => {
      setNewChannelModalOpen(false);
      setNewChannelLabel('');
      setNewChannelTopic('');
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      if (res.kind === 'created') {
        setActiveChannelMap((prev) => ({
          ...prev,
          [podId]: res.channel.channelId,
        }));
      } else {
        setComposerNotice('Opened YES/NO pod vote to add channel.');
        queryClient.invalidateQueries({ queryKey: ['proposals', podId] });
        queryClient.invalidateQueries({
          queryKey: ['messages', podId, channelId],
        });
      }
    },
    onError: (err) => {
      setComposerNotice(
        err instanceof Error ? err.message : 'Channel creation failed.'
      );
    },
  });

  const rematchMutation = useMutation({
    mutationFn: () => leavePod(podId, { rematch: true }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      if (res.newPod) {
        setActivePodId(res.newPod.podId);
        setComposerNotice(
          `Rematched into #${res.newPod.code} as ${res.newPod.myAlias}`
        );
      } else {
        setComposerNotice('Left pod; pick a new pod in Pods tab.');
      }
    },
  });

  const handleDraftChange = (text: string) => {
    setDraft(text);
    if (!channelId) return;
    if (text.trim().length > 0) {
      sendFrame({ type: 'typing', channelId, isTyping: true });
      if (typingStopTimerRef.current) {
        clearTimeout(typingStopTimerRef.current);
      }
      typingStopTimerRef.current = setTimeout(() => {
        sendFrame({ type: 'typing', channelId, isTyping: false });
      }, 2400);
    } else {
      sendFrame({ type: 'typing', channelId, isTyping: false });
    }
  };

  const handleSendText = () => {
    const trimmed = draft.trim();
    if (!trimmed || !podId || !channelId || postMutation.isPending) return;
    if (trimmed === '/invite') {
      setDraft('');
      setInviteModalOpen(true);
      return;
    }
    if (trimmed === '/rematch') {
      setDraft('');
      rematchMutation.mutate();
      return;
    }
    sendFrame({ type: 'typing', channelId, isTyping: false });
    postMutation.mutate({
      body: trimmed,
      quoteMessageId: quoteTarget?.id ?? 0,
    });
  };

  const handleSlashChip = (cmd: string) => {
    if (cmd === '/invite') {
      setInviteModalOpen(true);
    } else if (cmd === '/poll') {
      setDraft('/poll "What should our pod do next?" "Option A" "Option B"');
    } else if (cmd === '/icebreaker') {
      if (podId && channelId) {
        postMutation.mutate({ body: '/icebreaker' });
      }
    } else if (cmd === '/shrug') {
      setDraft((prev) => (prev ? `/shrug ${prev}` : '/shrug all good'));
    } else if (cmd === '/rematch') {
      rematchMutation.mutate();
    }
  };

  const startVoiceRecording = async () => {
    setComposerNotice(null);
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        setComposerNotice(
          'Microphone permission denied. Enable mic access in settings for Voice Notes.'
        );
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;
      setRecordElapsedSec(0);
      setIsRecording(true);
      recordTimerRef.current = setInterval(() => {
        setRecordElapsedSec((s) => s + 1);
      }, 1000);
    } catch {
      setComposerNotice(
        'Voice recorder unavailable on this simulator/browser — try on a physical device or enable mic input.'
      );
    }
  };

  const cancelVoiceRecording = async () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (recordingRef.current) {
      try {
        await recordingRef.current.stopAndUnloadAsync();
      } catch {
        // ignore stop errors
      }
      recordingRef.current = null;
    }
    setIsRecording(false);
    setRecordElapsedSec(0);
  };

  const finishAndSendVoiceNote = async () => {
    if (!recordingRef.current || !podId || !channelId) return;
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    const rec = recordingRef.current;
    recordingRef.current = null;
    setIsRecording(false);
    setUploadingVoice(true);

    try {
      const status = await rec.getStatusAsync();
      const durationMs =
        ('durationMillis' in status && status.durationMillis) ||
        recordElapsedSec * 1000 ||
        1500;
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      if (!uri) {
        throw new Error('No audio URI recorded');
      }
      const attachment = await uploadVoiceNoteAttachment(
        podId,
        uri,
        durationMs
      );
      await postMessage(podId, channelId, {
        body: draft.trim() || 'Voice note',
        quoteMessageId: quoteTarget?.id ?? 0,
        attachmentIds: [attachment.id],
      });
      setDraft('');
      setQuoteTarget(null);
      queryClient.invalidateQueries({
        queryKey: ['messages', podId, channelId],
      });
    } catch (err) {
      setComposerNotice(
        err instanceof Error ? err.message : 'Failed to upload voice note.'
      );
    } finally {
      setUploadingVoice(false);
      setRecordElapsedSec(0);
    }
  };

  if (!activePod) {
    return (
      <View style={styles.emptyPodState}>
        <Ionicons
          name="chatbubble-ellipses-outline"
          size={34}
          color={PALETTE.forest}
        />
        <Text style={styles.emptyPodTitle}>Join a Pod to Start Chatting</Text>
        <Text style={styles.emptyPodBody}>
          Head to the Pods tab to match into an anonymous 25-member Compact,
          Standard, or Club pod.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setActiveTab('pods')}
          style={styles.goPodsBtn}
        >
          <Text style={styles.goPodsBtnText}>Browse Pods & Match</Text>
        </Pressable>
      </View>
    );
  }

  const typingAliases = (typingByChannel[channelId] ?? []).filter(
    (a) => a !== activePod.myAlias
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Top Pod Switcher Bar + Channel Strip */}
      <View style={styles.topHeader}>
        <View style={styles.podBarRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Switch active pod"
            onPress={() => setPodSwitcherOpen(true)}
            style={styles.podSwitcherPill}
          >
            <Text style={styles.podSwitcherText} numberOfLines={1}>
              {activePod.title?.trim()
                ? activePod.title
                : `#${activePod.code}`}{' '}
              ▾
            </Text>
          </Pressable>

          <View style={styles.podMetaRight}>
            <View
              style={[
                styles.wsDot,
                { backgroundColor: wsConnected ? PALETTE.mint : PALETTE.amber },
              ]}
            />
            <Text style={styles.myAliasHeaderText} numberOfLines={1}>
              {activePod.myAlias}
            </Text>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Votes / Manage pod governance"
              onPress={() => setGovernanceModalOpen(true)}
              style={styles.headerGovBtn}
            >
              <Ionicons
                name={
                  activePod.governanceMode === 'ADMIN'
                    ? 'settings-outline'
                    : 'hammer-outline'
                }
                size={15}
                color={PALETTE.mint}
              />
              <Text style={styles.headerGovBtnText}>
                {activePod.governanceMode === 'ADMIN' ? 'Manage' : 'Votes'}
              </Text>
              {activePod.openProposalsCount > 0 ? (
                <View style={styles.openVoteBadge}>
                  <Text style={styles.openVoteBadgeText}>
                    {activePod.openProposalsCount}
                  </Text>
                </View>
              ) : null}
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Share / Invite"
              onPress={() => setInviteModalOpen(true)}
              style={styles.headerInviteBtn}
            >
              <Ionicons
                name="share-social-outline"
                size={18}
                color={PALETTE.mint}
              />
            </Pressable>
          </View>
        </View>

        {/* Horizontal Scrollable Text Channels */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.channelsStrip}
        >
          {textChannels.map((ch) => {
            const selected = ch.channelId === channelId;
            return (
              <Pressable
                key={ch.channelId}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() =>
                  setActiveChannelMap((prev) => ({
                    ...prev,
                    [activePod.podId]: ch.channelId,
                  }))
                }
                style={[
                  styles.channelPill,
                  selected && styles.channelPillActive,
                ]}
              >
                <Text
                  style={[
                    styles.channelPillText,
                    selected && styles.channelPillTextActive,
                  ]}
                >
                  #{ch.slug}
                </Text>
              </Pressable>
            );
          })}

          {activePod.governanceMode !== 'ADMIN' ||
          activePod.myRole === 'OWNER' ||
          activePod.myRole === 'ADMIN' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create text channel"
              onPress={() => setNewChannelModalOpen(true)}
              style={styles.addChannelPill}
            >
              <Text style={styles.addChannelPillText}>
                {activePod.governanceMode !== 'ADMIN' &&
                activePod.memberCount > 1
                  ? '+ Vote Channel'
                  : '+ Channel'}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </View>

      {/* Messages FlatList */}
      {messagesQuery.isLoading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator color={PALETTE.forest} />
        </View>
      ) : (
        <FlatList
          data={chronologicalMessages}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={styles.messagesList}
          ListHeaderComponent={
            messagesQuery.hasNextPage ? (
              <Pressable
                accessibilityRole="button"
                disabled={messagesQuery.isFetchingNextPage}
                onPress={() => messagesQuery.fetchNextPage()}
                style={styles.loadEarlierBtn}
              >
                {messagesQuery.isFetchingNextPage ? (
                  <ActivityIndicator size="small" color={PALETTE.forest} />
                ) : (
                  <Text style={styles.loadEarlierText}>
                    ↑ Load earlier messages
                  </Text>
                )}
              </Pressable>
            ) : (
              <View style={styles.channelIntroCard}>
                <Text style={styles.channelIntroTitle}>
                  Welcome to #{activeChannel?.label ?? 'general'}
                </Text>
                <Text style={styles.channelIntroSub}>
                  {activeChannel?.topic ||
                    'Peer-blind channel: try **bold**, `code`, ||spoilers||, /poll, or Voice Notes.'}
                </Text>
              </View>
            )
          }
          renderItem={({ item }) => (
            <MessageCard
              message={item}
              myPeerId={activePod.myPeerId}
              onOpenActions={(msg) => setActionTarget(msg)}
              onOpenThread={(msg) => setThreadParent(msg)}
              onToggleReaction={(messageId, emoji) =>
                reactMutation.mutate({ messageId, emoji })
              }
              onVotePoll={(pollId, optionIndex) =>
                voteMutation.mutate({ pollId, optionIndex })
              }
              onVoteProposal={(proposalId, vote) =>
                voteProposalMutation.mutate({ proposalId, vote })
              }
            />
          )}
          ListEmptyComponent={
            <Text style={styles.emptyChannelText}>
              No messages yet. Tap /icebreaker below to spark the pod!
            </Text>
          }
        />
      )}

      {/* Typing Indicator + Notice + Quote Banner */}
      {typingAliases.length > 0 ? (
        <View style={styles.typingStrip}>
          <Text style={styles.typingText}>
            {typingAliases.join(', ')}{' '}
            {typingAliases.length === 1 ? 'is' : 'are'} typing...
          </Text>
        </View>
      ) : null}

      {composerNotice ? (
        <View style={styles.noticeBar}>
          <Text style={styles.noticeText} numberOfLines={2}>
            {composerNotice}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setComposerNotice(null)}
            style={styles.smallCloseBtn}
          >
            <Ionicons name="close" size={16} color={PALETTE.ink} />
          </Pressable>
        </View>
      ) : null}

      {quoteTarget ? (
        <View style={styles.quoteComposerBanner}>
          <View style={styles.quoteComposerTextCol}>
            <Text style={styles.quoteComposerAuthor}>
              Quoting {quoteTarget.senderAlias}
            </Text>
            <Text style={styles.quoteComposerSnippet} numberOfLines={1}>
              {quoteTarget.body || 'Attachment'}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel quote reply"
            onPress={() => setQuoteTarget(null)}
            style={styles.smallCloseBtn}
          >
            <Ionicons name="close" size={18} color={PALETTE.muted} />
          </Pressable>
        </View>
      ) : null}

      {/* Rich Composer Footer */}
      <View style={styles.composerWrap}>
        {/* Quick Slash Command Strip */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.slashStrip}
          keyboardShouldPersistTaps="handled"
        >
          {SLASH_CHIPS.map((chip) => (
            <Pressable
              key={chip.cmd}
              accessibilityRole="button"
              accessibilityLabel={`Slash command ${chip.label}`}
              onPress={() => handleSlashChip(chip.cmd)}
              style={styles.slashChip}
            >
              <Text style={styles.slashChipText}>{chip.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {isRecording ? (
          <View style={styles.recordingBar}>
            <View style={styles.recordLiveInfo}>
              <View style={styles.recordRedDot} />
              <Text style={styles.recordingTimerText}>
                Recording Voice Note · 0:
                {recordElapsedSec.toString().padStart(2, '0')}
              </Text>
            </View>
            <View style={styles.recordActions}>
              <Pressable
                accessibilityRole="button"
                onPress={cancelVoiceRecording}
                style={styles.cancelRecBtn}
              >
                <Text style={styles.cancelRecText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={finishAndSendVoiceNote}
                style={styles.sendRecBtn}
              >
                <Text style={styles.sendRecText}>Send Voice</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.composerInputRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Record voice note"
              disabled={uploadingVoice}
              onPress={startVoiceRecording}
              style={styles.micBtn}
            >
              {uploadingVoice ? (
                <ActivityIndicator size="small" color={PALETTE.forest} />
              ) : (
                <Ionicons name="mic-outline" size={20} color={PALETTE.ink} />
              )}
            </Pressable>

            <TextInput
              value={draft}
              onChangeText={handleDraftChange}
              placeholder={`Message #${activeChannel?.slug ?? 'general'}...`}
              placeholderTextColor={PALETTE.muted}
              multiline
              style={styles.composerInput}
            />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send message"
              disabled={!draft.trim() || postMutation.isPending}
              onPress={handleSendText}
              style={[
                styles.sendBtn,
                (!draft.trim() || postMutation.isPending) &&
                  styles.sendBtnDisabled,
              ]}
            >
              <Ionicons name="send" size={18} color={PALETTE.charcoal} />
            </Pressable>
          </View>
        )}
      </View>

      {/* Slack Thread Modal */}
      <ThreadModal
        visible={!!threadParent}
        podId={podId}
        channelId={channelId}
        channelLabel={activeChannel?.slug ?? 'general'}
        myPeerId={activePod.myPeerId}
        parentMessage={threadParent}
        onClose={() => setThreadParent(null)}
      />

      {/* Pod Share / Invite Modal */}
      <InviteShareModal
        visible={inviteModalOpen}
        pod={activePod}
        onClose={() => setInviteModalOpen(false)}
      />

      {/* Pod Governance / Admin Management Modal */}
      <PodGovernanceModal
        visible={governanceModalOpen}
        pod={activePod}
        onClose={() => setGovernanceModalOpen(false)}
      />

      {/* Message Action Sheet Modal */}
      <Modal
        visible={!!actionTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setActionTarget(null)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setActionTarget(null)}
        >
          <Pressable style={styles.sheetCard} onPress={() => {}}>
            <Text style={styles.sheetTitle}>
              Message from {actionTarget?.senderAlias}
            </Text>

            {/* Quick Emoji React Row */}
            <View style={styles.emojiBar}>
              {QUICK_EMOJIS.map((emoji) => (
                <Pressable
                  key={emoji}
                  accessibilityRole="button"
                  accessibilityLabel={`React with ${emoji}`}
                  onPress={() => {
                    if (actionTarget) {
                      reactMutation.mutate({
                        messageId: actionTarget.id,
                        emoji,
                      });
                    }
                    setActionTarget(null);
                  }}
                  style={styles.sheetEmojiBtn}
                >
                  <Text style={styles.sheetEmojiText}>{emoji}</Text>
                </Pressable>
              ))}
            </View>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const target = actionTarget;
                setActionTarget(null);
                if (target) setThreadParent(target);
              }}
              style={styles.sheetActionRow}
            >
              <Ionicons
                name="chatbubbles-outline"
                size={18}
                color={PALETTE.forest}
              />
              <Text style={styles.sheetActionText}>Reply in Slack Thread</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const target = actionTarget;
                setActionTarget(null);
                if (target) setQuoteTarget(target);
              }}
              style={styles.sheetActionRow}
            >
              <Ionicons
                name="return-down-forward-outline"
                size={18}
                color={PALETTE.ink}
              />
              <Text style={styles.sheetActionText}>Quote Reply</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (actionTarget) pinMutation.mutate(actionTarget.id);
                setActionTarget(null);
              }}
              style={styles.sheetActionRow}
            >
              <Ionicons name="pin-outline" size={18} color={PALETTE.ink} />
              <Text style={styles.sheetActionText}>
                {actionTarget?.isPinned ? 'Unpin from Pod' : 'Pin to Pod'}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (actionTarget) bookmarkMutation.mutate(actionTarget.id);
                setActionTarget(null);
              }}
              style={styles.sheetActionRow}
            >
              <Ionicons name="bookmark-outline" size={18} color={PALETTE.ink} />
              <Text style={styles.sheetActionText}>
                {actionTarget?.isBookmarked
                  ? 'Remove Saved Bookmark'
                  : 'Bookmark Message'}
              </Text>
            </Pressable>

            {actionTarget?.senderPeerId === activePod.myPeerId ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  if (actionTarget) deleteMutation.mutate(actionTarget.id);
                  setActionTarget(null);
                }}
                style={styles.sheetActionRow}
              >
                <Ionicons
                  name="trash-outline"
                  size={18}
                  color={PALETTE.danger}
                />
                <Text
                  style={[styles.sheetActionText, { color: PALETTE.danger }]}
                >
                  Delete My Message
                </Text>
              </Pressable>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Pod Switcher Sheet */}
      <Modal
        visible={podSwitcherOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPodSwitcherOpen(false)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setPodSwitcherOpen(false)}
        >
          <Pressable style={styles.sheetCard} onPress={() => {}}>
            <Text style={styles.sheetTitle}>Switch Active Pod</Text>
            {pods.map((p) => {
              const selected = p.podId === activePod.podId;
              return (
                <Pressable
                  key={p.podId}
                  accessibilityRole="button"
                  onPress={() => {
                    setActivePodId(p.podId);
                    setPodSwitcherOpen(false);
                  }}
                  style={[
                    styles.podSwitchRow,
                    selected && styles.podSwitchRowActive,
                  ]}
                >
                  <View style={styles.podSwitchCol}>
                    <Text style={styles.podSwitchCode}>
                      {p.title?.trim() ? p.title : `#${p.code}`}
                    </Text>
                    <Text style={styles.podSwitchSub}>
                      {p.governanceMode === 'ADMIN'
                        ? '👑 Admin'
                        : '⚖️ Democratic'}{' '}
                      · {p.interestLabel} · You: {p.myAlias}
                    </Text>
                  </View>
                  <Text style={styles.podSwitchTier}>
                    {capacityTierBadge(p.memberCount, p.maxMembers)}
                  </Text>
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Create Channel Modal */}
      <Modal
        visible={newChannelModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setNewChannelModalOpen(false)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setNewChannelModalOpen(false)}
        >
          <Pressable style={styles.sheetCard} onPress={() => {}}>
            <Text style={styles.sheetTitle}>Create Text Channel</Text>
            <TextInput
              value={newChannelLabel}
              onChangeText={setNewChannelLabel}
              placeholder="e.g. clips-and-builds"
              placeholderTextColor={PALETTE.muted}
              autoCapitalize="none"
              style={styles.modalInput}
            />
            <TextInput
              value={newChannelTopic}
              onChangeText={setNewChannelTopic}
              placeholder="Optional topic..."
              placeholderTextColor={PALETTE.muted}
              style={styles.modalInput}
            />
            <View style={styles.modalBtnRow}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setNewChannelModalOpen(false)}
                style={styles.cancelRecBtn}
              >
                <Text style={styles.cancelRecText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={
                  !newChannelLabel.trim() || createChannelMutation.isPending
                }
                onPress={() => createChannelMutation.mutate()}
                style={styles.sendRecBtn}
              >
                <Text style={styles.sendRecText}>Create Channel</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PALETTE.surface,
  },
  emptyPodState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 10,
    backgroundColor: PALETTE.surface,
  },
  emptyPodTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  emptyPodBody: {
    fontSize: 14,
    lineHeight: 20,
    color: PALETTE.muted,
    textAlign: 'center',
  },
  goPodsBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1.5,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 6,
  },
  goPodsBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  topHeader: {
    backgroundColor: PALETTE.charcoal,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 8,
  },
  podBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    gap: 8,
  },
  podSwitcherPill: {
    flexShrink: 1,
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#2a2d2a',
    borderWidth: 1,
    borderColor: '#3a3f3a',
    justifyContent: 'center',
  },
  podSwitcherText: {
    color: PALETTE.mint,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO_FONT,
  },
  podMetaRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  wsDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  myAliasHeaderText: {
    maxWidth: 88,
    color: PALETTE.card,
    fontSize: 11,
    fontWeight: '600',
  },
  headerGovBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#2a2d2a',
    borderWidth: 1,
    borderColor: '#3a3f3a',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  headerGovBtnText: {
    color: PALETTE.mint,
    fontSize: 12,
    fontWeight: '700',
  },
  openVoteBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: PALETTE.mint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  openVoteBadgeText: {
    color: PALETTE.charcoal,
    fontSize: 10,
    fontWeight: '800',
    fontFamily: MONO_FONT,
  },
  headerInviteBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: '#2a2d2a',
    borderWidth: 1,
    borderColor: '#3a3f3a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  channelsStrip: {
    paddingHorizontal: 12,
    gap: 8,
  },
  channelPill: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: '#262926',
    alignItems: 'center',
    justifyContent: 'center',
  },
  channelPillActive: {
    backgroundColor: PALETTE.mint,
  },
  channelPillText: {
    color: '#d4d8d4',
    fontSize: 13,
    fontWeight: '600',
    fontFamily: MONO_FONT,
  },
  channelPillTextActive: {
    color: PALETTE.charcoal,
    fontWeight: '700',
  },
  addChannelPill: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#454b45',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addChannelPillText: {
    color: PALETTE.mint,
    fontSize: 12,
    fontWeight: '700',
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messagesList: {
    padding: 12,
    gap: 10,
  },
  loadEarlierBtn: {
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.card,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  loadEarlierText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  channelIntroCard: {
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    borderRadius: 14,
    padding: 12,
    marginBottom: 6,
    gap: 3,
  },
  channelIntroTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  channelIntroSub: {
    fontSize: 12,
    lineHeight: 17,
    color: PALETTE.ink,
  },
  emptyChannelText: {
    textAlign: 'center',
    color: PALETTE.muted,
    fontSize: 13,
    paddingVertical: 20,
  },
  typingStrip: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    backgroundColor: PALETTE.surfaceMuted,
  },
  typingText: {
    fontSize: 12,
    color: PALETTE.forest,
    fontWeight: '600',
  },
  noticeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: PALETTE.mintSoft,
    borderTopWidth: 1,
    borderTopColor: PALETTE.mintBorder,
  },
  noticeText: {
    flex: 1,
    fontSize: 12,
    color: PALETTE.forest,
    fontWeight: '600',
  },
  smallCloseBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quoteComposerBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    paddingRight: 6,
    backgroundColor: PALETTE.surfaceMuted,
    borderTopWidth: 1,
    borderTopColor: PALETTE.border,
  },
  quoteComposerTextCol: {
    flex: 1,
    paddingVertical: 6,
  },
  quoteComposerAuthor: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  quoteComposerSnippet: {
    fontSize: 12,
    color: PALETTE.muted,
  },
  composerWrap: {
    backgroundColor: PALETTE.card,
    borderTopWidth: 1,
    borderTopColor: PALETTE.border,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 6,
  },
  slashStrip: {
    paddingHorizontal: 10,
    gap: 6,
  },
  slashChip: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slashChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  composerInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 10,
    gap: 8,
  },
  micBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerInput: {
    flex: 1,
    minHeight: TOUCH_MIN,
    maxHeight: 110,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: PALETTE.ink,
  },
  sendBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.45,
  },
  recordingBar: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 8,
  },
  recordLiveInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  recordRedDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: PALETTE.danger,
  },
  recordingTimerText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.danger,
    fontFamily: MONO_FONT,
  },
  recordActions: {
    flexDirection: 'row',
    gap: 8,
  },
  cancelRecBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelRecText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.ink,
  },
  sendRecBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.mint,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendRecText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(25, 27, 25, 0.5)',
    justifyContent: 'flex-end',
    padding: 12,
  },
  sheetCard: {
    backgroundColor: PALETTE.card,
    borderRadius: 18,
    padding: 16,
    gap: 8,
  },
  sheetTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: PALETTE.charcoal,
    marginBottom: 4,
  },
  emojiBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
  },
  sheetEmojiBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetEmojiText: {
    fontSize: 20,
  },
  sheetActionRow: {
    minHeight: TOUCH_MIN,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
  },
  sheetActionText: {
    fontSize: 14,
    fontWeight: '600',
    color: PALETTE.ink,
  },
  podSwitchRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  podSwitchRowActive: {
    backgroundColor: PALETTE.mintSoft,
    borderColor: PALETTE.forest,
  },
  podSwitchCol: {
    gap: 2,
  },
  podSwitchCode: {
    fontSize: 14,
    fontWeight: '700',
    color: PALETTE.charcoal,
    fontFamily: MONO_FONT,
  },
  podSwitchSub: {
    fontSize: 12,
    color: PALETTE.muted,
  },
  podSwitchTier: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  modalInput: {
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    backgroundColor: PALETTE.surface,
    paddingHorizontal: 12,
    fontSize: 14,
    color: PALETTE.ink,
  },
  modalBtnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
});

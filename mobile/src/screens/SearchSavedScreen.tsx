import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAtom, useSetAtom } from 'jotai';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  fetchBookmarks,
  fetchPins,
  fetchPods,
  searchPodMessages,
  toggleBookmark,
  togglePin,
  toggleReaction,
  votePoll,
  voteProposal,
} from '../api/client';
import {
  activeDmPeerByPodAtom,
  activePodIdAtom,
  activeTabAtom,
} from '../state/atoms';
import {
  resolveDmPartnerPeerId,
  type PodDetailDto,
  type RichMessageDto,
} from '../types/canopy';
import { PALETTE, TOUCH_MIN } from '../theme/palette';
import { MessageCard } from '../components/MessageCard';

type SubMode = 'search' | 'pins' | 'saved';

const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

export function SearchSavedScreen() {
  const queryClient = useQueryClient();
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const setActiveDmPeerMap = useSetAtom(activeDmPeerByPodAtom);
  const setActiveTab = useSetAtom(activeTabAtom);

  const [mode, setMode] = useState<SubMode>('search');
  const [searchInput, setSearchInput] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');

  const podsQuery = useQuery({
    queryKey: ['pods'],
    queryFn: fetchPods,
  });

  const pods = podsQuery.data?.pods ?? [];
  const activePod: PodDetailDto | null = useMemo(() => {
    if (pods.length === 0) return null;
    return pods.find((p) => p.podId === activePodId) ?? pods[0];
  }, [pods, activePodId]);

  const podId = activePod?.podId ?? '';

  const searchQuery = useQuery({
    queryKey: ['search', podId, submittedQuery],
    queryFn: () => searchPodMessages(podId, submittedQuery),
    enabled: mode === 'search' && !!podId && submittedQuery.trim().length > 0,
  });

  const pinsQuery = useQuery({
    queryKey: ['pins', podId],
    queryFn: () => fetchPins(podId),
    enabled: mode === 'pins' && !!podId,
  });

  const bookmarksQuery = useQuery({
    queryKey: ['bookmarks'],
    queryFn: fetchBookmarks,
    enabled: mode === 'saved',
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
      queryClient.invalidateQueries({ queryKey: ['search', podId] });
      queryClient.invalidateQueries({ queryKey: ['pins', podId] });
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
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
      queryClient.invalidateQueries({ queryKey: ['search', podId] });
      queryClient.invalidateQueries({ queryKey: ['pins', podId] });
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
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
      queryClient.invalidateQueries({ queryKey: ['search', podId] });
      queryClient.invalidateQueries({ queryKey: ['pins', podId] });
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
      queryClient.invalidateQueries({ queryKey: ['proposals', podId] });
      queryClient.invalidateQueries({ queryKey: ['pods'] });
    },
  });

  const quickToggleItemMutation = useMutation({
    mutationFn: async (msg: RichMessageDto) => {
      if (mode === 'pins') {
        await togglePin(msg.id);
      } else {
        await toggleBookmark(msg.id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pins', podId] });
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
    },
  });

  const getMessageConvoMeta = (msg: RichMessageDto) => {
    const msgPod = pods.find((p) => p.podId === msg.podId);
    const partnerPeerId = resolveDmPartnerPeerId(
      msgPod?.myPeerId,
      msg.senderPeerId,
      msg.recipientPeerId
    );
    const partnerAlias = partnerPeerId
      ? msgPod && msg.senderPeerId === msgPod.myPeerId
        ? msg.recipientAlias || 'Peer'
        : msg.senderAlias
      : null;
    return {
      msgPod,
      partnerPeerId,
      partnerAlias,
      isPrivateDm: !!msg.recipientPeerId,
    };
  };

  const handleOpenInChat = (msg: RichMessageDto) => {
    const { partnerPeerId } = getMessageConvoMeta(msg);
    setActivePodId(msg.podId);
    setActiveDmPeerMap((prev) => ({
      ...prev,
      [msg.podId]: partnerPeerId,
    }));
    setActiveTab('chat');
  };

  const activeItems: RichMessageDto[] =
    mode === 'search'
      ? searchQuery.data?.messages ?? []
      : mode === 'pins'
      ? pinsQuery.data?.messages ?? []
      : bookmarksQuery.data?.messages ?? [];

  const isLoading =
    (mode === 'search' && searchQuery.isFetching) ||
    (mode === 'pins' && pinsQuery.isLoading) ||
    (mode === 'saved' && bookmarksQuery.isLoading);

  return (
    <View style={styles.container}>
      {/* Segmented Header: Search · Pinned · Saved */}
      <View style={styles.topSection}>
        <View style={styles.podScopeRow}>
          <Text style={styles.scopeLabel}>
            {mode === 'saved'
              ? 'Account-wide Private Bookmarks'
              : activePod
              ? `Scoped to #${activePod.code} (Group + Your DMs)`
              : 'Join a pod to search or view pins'}
          </Text>
          {activePod && pods.length > 1 && mode !== 'saved' ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                const idx = pods.findIndex((p) => p.podId === activePod.podId);
                const next = pods[(idx + 1) % pods.length];
                setActivePodId(next.podId);
              }}
              style={styles.cyclePodBtn}
            >
              <Text style={styles.cyclePodText}>Next Pod ↻</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.segmentedControl}>
          {(
            [
              { key: 'search', label: 'Search' },
              { key: 'pins', label: 'Pinned' },
              { key: 'saved', label: 'Saved' },
            ] as const
          ).map((tab) => {
            const active = mode === tab.key;
            return (
              <Pressable
                key={tab.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => setMode(tab.key)}
                style={[styles.segBtn, active && styles.segBtnActive]}
              >
                <Text
                  style={[styles.segBtnText, active && styles.segBtnTextActive]}
                >
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {mode === 'search' ? (
          <View style={styles.searchRow}>
            <TextInput
              value={searchInput}
              onChangeText={setSearchInput}
              onSubmitEditing={() => setSubmittedQuery(searchInput.trim())}
              placeholder={
                activePod
                  ? `Search Group Chat & your DMs in #${activePod.code}...`
                  : 'Join a pod first...'
              }
              placeholderTextColor={PALETTE.muted}
              returnKeyType="search"
              editable={!!activePod}
              style={styles.searchInput}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Run search"
              disabled={!activePod || !searchInput.trim()}
              onPress={() => setSubmittedQuery(searchInput.trim())}
              style={[
                styles.searchBtn,
                (!activePod || !searchInput.trim()) && styles.disabledBtn,
              ]}
            >
              <Ionicons name="search" size={18} color={PALETTE.charcoal} />
            </Pressable>
          </View>
        ) : null}
      </View>

      {isLoading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator color={PALETTE.forest} />
        </View>
      ) : (
        <FlatList
          data={activeItems}
          keyExtractor={(item) => `${mode}-${item.id}`}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const meta = getMessageConvoMeta(item);
            return (
              <View style={styles.resultWrap}>
                <View style={styles.contextBar}>
                  <View
                    style={[
                      styles.convoScopeBadge,
                      meta.isPrivateDm
                        ? styles.convoScopeDm
                        : styles.convoScopeGroup,
                    ]}
                  >
                    <Ionicons
                      name={meta.isPrivateDm ? 'lock-closed' : 'people'}
                      size={12}
                      color={PALETTE.forest}
                    />
                    <Text style={styles.convoScopeText}>
                      {meta.isPrivateDm
                        ? `Private DM${
                            meta.partnerAlias ? ` · ${meta.partnerAlias}` : ''
                          }`
                        : 'Group Chat'}
                    </Text>
                  </View>

                  {meta.msgPod ? (
                    <Text style={styles.podCodeTag}>#{meta.msgPod.code}</Text>
                  ) : null}
                </View>

                <MessageCard
                  message={item}
                  myPeerId={meta.msgPod?.myPeerId ?? activePod?.myPeerId}
                  onOpenActions={(msg) => quickToggleItemMutation.mutate(msg)}
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
                <Pressable
                  accessibilityRole="button"
                  onPress={() => handleOpenInChat(item)}
                  style={styles.jumpBtn}
                >
                  <Text style={styles.jumpBtnText}>
                    {meta.isPrivateDm
                      ? 'Open Private DM ->'
                      : 'Open Group Chat ->'}
                  </Text>
                </Pressable>
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons
                name={
                  mode === 'search'
                    ? 'search-outline'
                    : mode === 'pins'
                    ? 'pin-outline'
                    : 'bookmark-outline'
                }
                size={28}
                color={PALETTE.muted}
              />
              <Text style={styles.emptyText}>
                {mode === 'search'
                  ? submittedQuery
                    ? `No messages matched "${submittedQuery}".`
                    : 'Enter keywords above to run MySQL FULLTEXT search across Group Chat and your 1:1 DMs.'
                  : mode === 'pins'
                  ? 'No pinned Group Chat messages in this pod yet.'
                  : 'No saved bookmarks yet. Long-press any chat message to bookmark it.'}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PALETTE.surface,
  },
  topSection: {
    backgroundColor: PALETTE.card,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: PALETTE.border,
    gap: 10,
  },
  podScopeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  scopeLabel: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  cyclePodBtn: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    justifyContent: 'center',
  },
  cyclePodText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.ink,
  },
  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: PALETTE.surfaceMuted,
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  segBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segBtnActive: {
    backgroundColor: PALETTE.charcoal,
  },
  segBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: PALETTE.muted,
  },
  segBtnTextActive: {
    color: PALETTE.mint,
    fontWeight: '700',
  },
  searchRow: {
    flexDirection: 'row',
    gap: 8,
  },
  searchInput: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    paddingHorizontal: 12,
    fontSize: 14,
    color: PALETTE.ink,
  },
  searchBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: 12,
    backgroundColor: PALETTE.mint,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabledBtn: {
    opacity: 0.45,
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: {
    padding: 14,
    gap: 14,
  },
  resultWrap: {
    gap: 6,
  },
  contextBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  convoScopeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  convoScopeDm: {
    backgroundColor: PALETTE.mintSoft,
    borderColor: PALETTE.mintBorder,
  },
  convoScopeGroup: {
    backgroundColor: PALETTE.card,
    borderColor: PALETTE.borderStrong,
  },
  convoScopeText: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  podCodeTag: {
    fontSize: 11,
    fontWeight: '600',
    color: PALETTE.muted,
    fontFamily: MONO_FONT,
  },
  jumpBtn: {
    alignSelf: 'flex-end',
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    justifyContent: 'center',
  },
  jumpBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    paddingHorizontal: 20,
    gap: 8,
  },
  emptyText: {
    fontSize: 13,
    lineHeight: 19,
    color: PALETTE.muted,
    textAlign: 'center',
  },
});

import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '../theme/ui';
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
import { PIECES, TOUCH_MIN, pieceColor } from '../theme/palette';
import { Btn, Chip } from '../components/Pieces';
import { MessageCard } from '../components/MessageCard';

type SubMode = 'search' | 'pins' | 'saved';

const MONO_FONT = 'DMMono_500Medium';

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
      <View style={styles.topSection}>
        <View style={styles.segRow}>
          {(
            [
              { key: 'search', label: 'Search' },
              { key: 'pins', label: 'Pinned' },
              { key: 'saved', label: 'Saved' },
            ] as const
          ).map((tab) => (
            <Chip
              key={tab.key}
              label={tab.label}
              active={mode === tab.key}
              onPress={() => setMode(tab.key)}
            />
          ))}
        </View>

        <View style={styles.podScopeRow}>
          <Text style={styles.scopeLabel}>
            {mode === 'saved'
              ? 'Everything you saved, in every room'
              : activePod
              ? `In ${activePod.title?.trim() || activePod.interestLabel}: the group and your private chats`
              : 'Join a room to search or see its pins'}
          </Text>
          {activePod && pods.length > 1 && mode !== 'saved' ? (
            <Btn
              label="Next room"
              icon="refresh"
              onPress={() => {
                const idx = pods.findIndex((p) => p.podId === activePod.podId);
                const next = pods[(idx + 1) % pods.length];
                setActivePodId(next.podId);
              }}
              a11yLabel="Search the next room"
            />
          ) : null}
        </View>

        {mode === 'search' ? (
          <View style={styles.searchRow}>
            <TextInput
              value={searchInput}
              onChangeText={setSearchInput}
              onSubmitEditing={() => setSubmittedQuery(searchInput.trim())}
              placeholder={
                activePod
                  ? `Search ${activePod.title?.trim() || activePod.interestLabel}`
                  : 'Join a room first'
              }
              placeholderTextColor={PIECES.muted}
              returnKeyType="search"
              editable={!!activePod}
              accessibilityLabel="Search words"
              style={styles.searchInput}
            />
            <Btn
              label="Search"
              kind="blue"
              disabled={!activePod || !searchInput.trim()}
              onPress={() => setSubmittedQuery(searchInput.trim())}
              style={{ minHeight: 56, borderRadius: 28 }}
              a11yLabel="Run the search"
            />
          </View>
        ) : null}
      </View>

      {isLoading ? (
        <View style={styles.centerBox}>
          <ActivityIndicator color={PIECES.ink} />
        </View>
      ) : (
        <FlatList
          data={activeItems}
          keyExtractor={(item) => `${mode}-${item.id}`}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          renderItem={({ item }) => {
            const meta = getMessageConvoMeta(item);
            const place = meta.isPrivateDm
              ? `Private${meta.partnerAlias ? ` with ${meta.partnerAlias}` : ''}`
              : 'Group chat';
            return (
              <View style={styles.resultWrap}>
                <Text style={styles.placeTag}>
                  {place}
                  {meta.msgPod
                    ? ` · ${meta.msgPod.title?.trim() || meta.msgPod.interestLabel}`
                    : ''}
                </Text>

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
                <Btn
                  label={meta.isPrivateDm ? 'Open the private chat' : 'Open the group chat'}
                  kind="white"
                  onPress={() => handleOpenInChat(item)}
                />
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>
                {mode === 'search'
                  ? submittedQuery
                    ? 'Nothing matched'
                    : 'Look something up'
                  : mode === 'pins'
                  ? 'No pins yet'
                  : 'Nothing saved yet'}
              </Text>
              <Text style={styles.emptyText}>
                {mode === 'search'
                  ? submittedQuery
                    ? `No messages matched "${submittedQuery}".`
                    : 'Type a word or two to search the group chat and your private chats in this room.'
                  : mode === 'pins'
                  ? 'Nothing is pinned in this room. Press and hold a message to pin it.'
                  : 'Press and hold any message and choose Save it.'}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PIECES.bg },
  topSection: {
    backgroundColor: PIECES.sheet,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 14,
    gap: 12,
  },
  segRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  podScopeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  scopeLabel: { flex: 1, fontSize: 14, lineHeight: 20, color: PIECES.muted },
  searchRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  searchInput: {
    flex: 1,
    minHeight: 56,
    borderRadius: 28,
    backgroundColor: PIECES.bg,
    paddingHorizontal: 22,
    fontSize: 16,
    color: PIECES.ink,
  },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  listContent: { padding: 12, paddingBottom: 24, flexGrow: 1 },
  sep: { height: 16 },
  resultWrap: { gap: 6 },
  placeTag: { fontSize: 13, color: PIECES.muted, fontFamily: MONO_FONT, paddingHorizontal: 6 },
  emptyState: { alignItems: 'center', padding: 28, gap: 8 },
  emptyTitle: { fontSize: 22, color: PIECES.ink, fontWeight: '600' },
  emptyText: { fontSize: 15, lineHeight: 22, color: PIECES.muted, textAlign: 'center' },
});

import React, { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  fetchThread,
  postMessage,
  toggleReaction,
  votePoll,
  voteProposal,
} from '../api/client';
import type { RichMessage, ThreadPayload } from '../types/canopy';
import { PALETTE, TOUCH_MIN } from '../theme/palette';
import { MessageCard } from './MessageCard';

const QUICK_EMOJIS = ['🔥', '👍', '😂', '🎯', '❤️'];

export interface ThreadModalProps {
  visible: boolean;
  podId: string;
  channelId: string;
  channelLabel: string;
  myPeerId: string;
  parentMessage: RichMessage | null;
  onClose: () => void;
}

export function ThreadModal({
  visible,
  podId,
  channelId,
  channelLabel,
  myPeerId,
  parentMessage,
  onClose,
}: ThreadModalProps) {
  const queryClient = useQueryClient();
  const [replyBody, setReplyBody] = useState('');
  const parentId = parentMessage?.id ?? 0;

  const threadQuery = useQuery({
    queryKey: ['thread', podId, channelId, parentId],
    queryFn: () => fetchThread(podId, channelId, parentId),
    enabled: visible && !!podId && !!channelId && parentId > 0,
  });

  const sendReplyMutation = useMutation({
    mutationFn: (body: string) =>
      postMessage(podId, channelId, {
        body,
        parentMessageId: parentId,
      }),
    onSuccess: (res) => {
      setReplyBody('');
      if (res.message) {
        const created = res.message;
        queryClient.setQueryData(
          ['thread', podId, channelId, parentId],
          (old: ThreadPayload | undefined) => {
            if (!old) return old;
            const exists = old.replies.some((r) => r.id === created.id);
            return exists
              ? old
              : {
                  parent: {
                    ...old.parent,
                    replyCount: old.parent.replyCount + 1,
                  },
                  replies: [...old.replies, created],
                };
          }
        );
      }
      queryClient.invalidateQueries({
        queryKey: ['messages', podId, channelId],
      });
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
        queryKey: ['thread', podId, channelId, parentId],
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
        queryKey: ['thread', podId, channelId, parentId],
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
        queryKey: ['thread', podId, channelId, parentId],
      });
      queryClient.invalidateQueries({
        queryKey: ['messages', podId, channelId],
      });
      queryClient.invalidateQueries({ queryKey: ['proposals', podId] });
      queryClient.invalidateQueries({ queryKey: ['pods'] });
    },
  });

  const handleSend = () => {
    const trimmed = replyBody.trim();
    if (!trimmed || sendReplyMutation.isPending) return;
    sendReplyMutation.mutate(trimmed);
  };

  const activeParent = threadQuery.data?.parent ?? parentMessage;
  const replies = threadQuery.data?.replies ?? [];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          {/* Charcoal header */}
          <View style={styles.header}>
            <View style={styles.headerTitles}>
              <Text style={styles.headerTitle}>Slack Thread</Text>
              <Text style={styles.headerSub}>#{channelLabel} · Peer-blind</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close thread"
              onPress={onClose}
              style={styles.closeBtn}
            >
              <Ionicons name="close" size={22} color={PALETTE.card} />
            </Pressable>
          </View>

          {threadQuery.isLoading && !activeParent ? (
            <View style={styles.centerBox}>
              <ActivityIndicator color={PALETTE.forest} />
            </View>
          ) : (
            <FlatList
              data={replies}
              keyExtractor={(item) => String(item.id)}
              contentContainerStyle={styles.listContent}
              ListHeaderComponent={
                activeParent ? (
                  <View style={styles.parentSection}>
                    <MessageCard
                      message={activeParent}
                      myPeerId={myPeerId}
                      compactThreadView
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
                    <View style={styles.quickReactStrip}>
                      <Text style={styles.quickReactLabel}>Quick react:</Text>
                      {QUICK_EMOJIS.map((em) => (
                        <Pressable
                          key={em}
                          accessibilityRole="button"
                          accessibilityLabel={`React ${em} to thread starter`}
                          onPress={() =>
                            reactMutation.mutate({
                              messageId: activeParent.id,
                              emoji: em,
                            })
                          }
                          style={styles.quickEmojiBtn}
                        >
                          <Text style={styles.quickEmojiText}>{em}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <View style={styles.dividerRow}>
                      <Text style={styles.dividerLabel}>
                        {replies.length}{' '}
                        {replies.length === 1 ? 'reply' : 'replies'}
                      </Text>
                      <View style={styles.dividerLine} />
                    </View>
                  </View>
                ) : null
              }
              renderItem={({ item }) => (
                <MessageCard
                  message={item}
                  myPeerId={myPeerId}
                  compactThreadView
                  onToggleReaction={(messageId, emoji) =>
                    reactMutation.mutate({ messageId, emoji })
                  }
                  onVotePoll={(pollId, optionIndex) =>
                    voteMutation.mutate({ pollId, optionIndex })
                  }
                />
              )}
              ListEmptyComponent={
                !threadQuery.isLoading ? (
                  <Text style={styles.emptyReplies}>
                    No thread replies yet. Start the side conversation below.
                  </Text>
                ) : null
              }
            />
          )}

          {/* Reply composer */}
          <View style={styles.composerBar}>
            <TextInput
              value={replyBody}
              onChangeText={setReplyBody}
              placeholder="Reply in thread..."
              placeholderTextColor={PALETTE.muted}
              multiline
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send thread reply"
              onPress={handleSend}
              disabled={!replyBody.trim() || sendReplyMutation.isPending}
              style={[
                styles.sendBtn,
                (!replyBody.trim() || sendReplyMutation.isPending) &&
                  styles.sendBtnDisabled,
              ]}
            >
              <Ionicons name="send" size={18} color={PALETTE.charcoal} />
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: PALETTE.surface,
  },
  flex: {
    flex: 1,
  },
  header: {
    backgroundColor: PALETTE.charcoal,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitles: {
    gap: 2,
  },
  headerTitle: {
    color: PALETTE.card,
    fontSize: 17,
    fontWeight: '700',
  },
  headerSub: {
    color: PALETTE.mint,
    fontSize: 12,
    fontWeight: '600',
  },
  closeBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2a2d2a',
  },
  centerBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: {
    padding: 14,
    gap: 10,
  },
  parentSection: {
    gap: 10,
    marginBottom: 4,
  },
  quickReactStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  quickReactLabel: {
    fontSize: 12,
    color: PALETTE.muted,
    marginRight: 4,
  },
  quickEmojiBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.card,
    borderWidth: 1,
    borderColor: PALETTE.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickEmojiText: {
    fontSize: 17,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  dividerLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.muted,
    textTransform: 'uppercase',
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: PALETTE.borderStrong,
  },
  emptyReplies: {
    textAlign: 'center',
    color: PALETTE.muted,
    fontSize: 13,
    paddingVertical: 20,
  },
  composerBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: PALETTE.card,
    borderTopWidth: 1,
    borderTopColor: PALETTE.border,
  },
  input: {
    flex: 1,
    minHeight: TOUCH_MIN,
    maxHeight: 110,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    borderRadius: 12,
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
});

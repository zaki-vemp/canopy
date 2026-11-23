import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { RichMessageDto } from '../types/canopy';
import {
  PALETTE,
  TOUCH_MIN,
  aliasInitials,
  safePeerColor,
} from '../theme/palette';
import { RichTextBody } from './RichTextBody';
import { VoiceNotePlayer } from './VoiceNotePlayer';

const MONO_FONT = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

function formatShortTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export interface MessageCardProps {
  message: RichMessageDto;
  myPeerId?: string;
  isDmView?: boolean;
  onOpenActions?: (message: RichMessageDto) => void;
  onMessagePrivately?: (peerId: string, alias: string) => void;
  onReplyQuote?: (message: RichMessageDto) => void;
  onToggleReaction?: (messageId: number, emoji: string) => void;
  onVotePoll?: (pollId: number, optionIndex: number) => void;
  onVoteProposal?: (proposalId: number, vote: boolean) => void;
}

export function MessageCard({
  message,
  myPeerId,
  isDmView = false,
  onOpenActions,
  onMessagePrivately,
  onReplyQuote,
  onToggleReaction,
  onVotePoll,
  onVoteProposal,
}: MessageCardProps) {
  if (message.msgType === 'SYSTEM') {
    return (
      <View style={styles.systemRow}>
        <View style={styles.systemPill}>
          <RichTextBody body={message.body} />
        </View>
      </View>
    );
  }

  const peerColor = safePeerColor(message.senderColor, message.senderAlias);
  const isSelf = !!myPeerId && message.senderPeerId === myPeerId;
  const isIcebreaker = message.msgType === 'ICEBREAKER';
  const isGovernance = message.msgType === 'GOVERNANCE' && !!message.proposal;
  const proposal = message.proposal ?? null;
  const canDmSender =
    !isDmView &&
    !isSelf &&
    !!message.senderPeerId &&
    !message.isDeleted &&
    (!!onMessagePrivately || !!onOpenActions);

  const totalPollVotes = message.poll
    ? message.poll.options.reduce((acc, opt) => acc + opt.votes, 0)
    : 0;

  return (
    <Pressable
      onLongPress={
        onOpenActions && !message.isDeleted
          ? () => onOpenActions(message)
          : undefined
      }
      delayLongPress={260}
      style={[
        styles.card,
        isDmView && (isSelf ? styles.dmBubbleSelf : styles.dmBubblePeer),
        !isDmView && isSelf && styles.groupSelfCard,
        isIcebreaker && styles.icebreakerCard,
        isGovernance && styles.governanceOuterCard,
        message.isPinned && styles.pinnedCard,
      ]}
    >
      {/* Header row: blind animal avatar + alias + badges + 44pt menu trigger */}
      <View style={styles.headerRow}>
        <Pressable
          accessibilityRole={canDmSender ? 'button' : undefined}
          accessibilityLabel={
            canDmSender
              ? `Options for ${message.senderAlias}, including Message privately`
              : undefined
          }
          disabled={!canDmSender}
          onPress={() => {
            if (onOpenActions) {
              onOpenActions(message);
            } else if (onMessagePrivately && message.senderPeerId) {
              onMessagePrivately(message.senderPeerId, message.senderAlias);
            }
          }}
          style={styles.authorTapRow}
        >
          {!(isDmView && isSelf) ? (
            <View style={[styles.avatarCircle, { backgroundColor: peerColor }]}>
              <Text style={styles.avatarText}>
                {aliasInitials(message.senderAlias)}
              </Text>
            </View>
          ) : null}

          <View style={styles.headerMeta}>
            <View style={styles.aliasRow}>
              <Text
                style={[
                  styles.aliasName,
                  { color: isSelf && isDmView ? PALETTE.forest : peerColor },
                ]}
              >
                {isSelf && isDmView ? 'You' : message.senderAlias}
              </Text>
              {isSelf && !isDmView ? (
                <View style={styles.youBadge}>
                  <Text style={styles.youBadgeText}>YOU</Text>
                </View>
              ) : null}
              {message.isPinned ? (
                <View style={styles.pinBadge}>
                  <Ionicons name="pin" size={11} color={PALETTE.forest} />
                  <Text style={styles.pinBadgeText}>pinned</Text>
                </View>
              ) : null}
              {message.isBookmarked ? (
                <View style={styles.savedBadge}>
                  <Ionicons name="bookmark" size={11} color={PALETTE.charcoal} />
                </View>
              ) : null}
            </View>
            <Text style={styles.timestampText}>
              {formatShortTime(message.createdAt)}
              {message.editedAt ? ' · edited' : ''}
            </Text>
          </View>
        </Pressable>

        {onOpenActions && !message.isDeleted ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Actions for message from ${message.senderAlias}`}
            onPress={() => onOpenActions(message)}
            style={styles.moreBtn}
          >
            <Ionicons
              name="ellipsis-horizontal"
              size={18}
              color={PALETTE.muted}
            />
          </Pressable>
        ) : null}
      </View>

      {isIcebreaker ? (
        <View style={styles.icebreakerBanner}>
          <Ionicons name="sparkles-outline" size={14} color={PALETTE.forest} />
          <Text style={styles.icebreakerLabel}>POD ICEBREAKER</Text>
        </View>
      ) : null}

      {/* Quoted reply preview */}
      {message.quoteMessage ? (
        <View
          style={[
            styles.quoteBox,
            isDmView && isSelf && styles.quoteBoxOnMint,
          ]}
        >
          <Text style={styles.quoteAuthor}>
            {message.quoteMessage.senderAlias}
          </Text>
          <Text style={styles.quoteBody} numberOfLines={2}>
            {message.quoteMessage.isDeleted
              ? 'Deleted message'
              : message.quoteMessage.body || 'Voice note / attachment'}
          </Text>
        </View>
      ) : null}

      {/* Main body or Deleted notice */}
      {message.isDeleted ? (
        <Text style={styles.deletedText}>This message was removed.</Text>
      ) : (
        <View style={styles.bodyWrap}>
          {message.body &&
          message.msgType !== 'POLL' &&
          !isGovernance ? (
            <RichTextBody body={message.body} />
          ) : null}

          {/* Interactive Democratic Governance Vote Card */}
          {proposal ? (
            <View style={styles.govCard}>
              <View style={styles.govTopRow}>
                <View style={styles.govLabelRow}>
                  <Ionicons
                    name="hammer-outline"
                    size={15}
                    color={PALETTE.forest}
                  />
                  <Text style={styles.govKindLabel}>⚖️ POD VOTE</Text>
                </View>
                <View
                  style={[
                    styles.govStatusBadge,
                    proposal.status === 'PASSED'
                      ? styles.govStatusPassed
                      : proposal.status === 'REJECTED'
                      ? styles.govStatusRejected
                      : styles.govStatusOpen,
                  ]}
                >
                  <Text
                    style={[
                      styles.govStatusText,
                      proposal.status === 'PASSED'
                        ? styles.govStatusTextPassed
                        : proposal.status === 'REJECTED'
                        ? styles.govStatusTextRejected
                        : styles.govStatusTextOpen,
                    ]}
                  >
                    {proposal.status}
                  </Text>
                </View>
              </View>

              <Text style={styles.govTitle}>{proposal.title}</Text>
              {proposal.reason ? (
                <Text style={styles.govReason}>
                  Reason: {proposal.reason}
                </Text>
              ) : null}

              {/* YES vs NO Tally */}
              <View style={styles.govTallyBox}>
                <View style={styles.govCountsRow}>
                  <Text style={styles.govYesStat}>
                    YES: {proposal.yesCount}
                  </Text>
                  <Text style={styles.govEligibleStat}>
                    {proposal.eligibleCount} eligible
                  </Text>
                  <Text style={styles.govNoStat}>NO: {proposal.noCount}</Text>
                </View>
                <View style={styles.govTrack}>
                  <View
                    style={[
                      styles.govYesBar,
                      {
                        width: `${
                          proposal.eligibleCount > 0
                            ? Math.min(
                                100,
                                Math.round(
                                  (proposal.yesCount / proposal.eligibleCount) *
                                    100
                                )
                              )
                            : 0
                        }%`,
                      },
                    ]}
                  />
                  <View
                    style={[
                      styles.govNoBar,
                      {
                        width: `${
                          proposal.eligibleCount > 0
                            ? Math.min(
                                100,
                                Math.round(
                                  (proposal.noCount / proposal.eligibleCount) *
                                    100
                                )
                              )
                            : 0
                        }%`,
                      },
                    ]}
                  />
                </View>
                {proposal.yesAliases.length > 0 ? (
                  <Text style={styles.govAliasesText} numberOfLines={1}>
                    YES: {proposal.yesAliases.join(', ')}
                  </Text>
                ) : null}
                {proposal.noAliases.length > 0 ? (
                  <Text style={styles.govAliasesText} numberOfLines={1}>
                    NO: {proposal.noAliases.join(', ')}
                  </Text>
                ) : null}
              </View>

              {proposal.status === 'OPEN' ? (
                <View style={styles.govButtonsRow}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Vote YES on ${proposal.title}`}
                    disabled={!onVoteProposal}
                    onPress={() =>
                      onVoteProposal && onVoteProposal(proposal.id, true)
                    }
                    style={[
                      styles.govVoteYesBtn,
                      proposal.myVote === true && styles.govVoteYesBtnActive,
                    ]}
                  >
                    <Ionicons
                      name={
                        proposal.myVote === true
                          ? 'checkmark-circle'
                          : 'thumbs-up-outline'
                      }
                      size={17}
                      color={PALETTE.charcoal}
                    />
                    <Text style={styles.govVoteYesText}>
                      {proposal.myVote === true ? 'Voted YES' : 'Vote YES'} (
                      {proposal.yesCount})
                    </Text>
                  </Pressable>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Vote NO on ${proposal.title}`}
                    disabled={!onVoteProposal}
                    onPress={() =>
                      onVoteProposal && onVoteProposal(proposal.id, false)
                    }
                    style={[
                      styles.govVoteNoBtn,
                      proposal.myVote === false && styles.govVoteNoBtnActive,
                    ]}
                  >
                    <Ionicons
                      name={
                        proposal.myVote === false
                          ? 'close-circle'
                          : 'thumbs-down-outline'
                      }
                      size={17}
                      color={
                        proposal.myVote === false ? PALETTE.danger : PALETTE.ink
                      }
                    />
                    <Text
                      style={[
                        styles.govVoteNoText,
                        proposal.myVote === false &&
                          styles.govVoteNoTextActive,
                      ]}
                    >
                      {proposal.myVote === false ? 'Voted NO' : 'Vote NO'} (
                      {proposal.noCount})
                    </Text>
                  </Pressable>
                </View>
              ) : null}

              <Text style={styles.govFooterText}>
                Proposed by {proposal.proposerAlias} · Democratic YES &gt; NO vote
              </Text>
            </View>
          ) : null}

          {/* Interactive /poll card */}
          {message.poll ? (
            <View style={styles.pollCard}>
              <View style={styles.pollHeader}>
                <Ionicons
                  name="stats-chart"
                  size={15}
                  color={PALETTE.forest}
                />
                <Text style={styles.pollQuestion}>{message.poll.question}</Text>
              </View>

              <View style={styles.pollOptionsList}>
                {message.poll.options.map((opt) => {
                  const pct =
                    totalPollVotes > 0
                      ? Math.round((opt.votes / totalPollVotes) * 100)
                      : 0;
                  return (
                    <Pressable
                      key={opt.index}
                      accessibilityRole="button"
                      accessibilityLabel={`Vote ${opt.label}, ${opt.votes} votes`}
                      disabled={message.poll?.isClosed || !onVotePoll}
                      onPress={() =>
                        message.poll &&
                        onVotePoll &&
                        onVotePoll(message.poll.pollId, opt.index)
                      }
                      style={[
                        styles.pollOptionBtn,
                        opt.meVoted && styles.pollOptionVoted,
                      ]}
                    >
                      <View
                        style={[styles.pollFillBar, { width: `${pct}%` }]}
                      />
                      <View style={styles.pollOptionContent}>
                        <View style={styles.pollLabelWrap}>
                          <Ionicons
                            name={
                              opt.meVoted
                                ? 'checkmark-circle'
                                : 'ellipse-outline'
                            }
                            size={18}
                            color={
                              opt.meVoted ? PALETTE.forest : PALETTE.muted
                            }
                          />
                          <Text style={styles.pollOptionLabel}>
                            {opt.label}
                          </Text>
                        </View>
                        <Text style={styles.pollVoteCount}>
                          {opt.votes} ({pct}%)
                        </Text>
                      </View>
                      {opt.voters.length > 0 ? (
                        <Text style={styles.pollVotersText} numberOfLines={1}>
                          {opt.voters.join(', ')}
                        </Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.pollFooter}>
                {totalPollVotes} {totalPollVotes === 1 ? 'vote' : 'votes'} ·
                Peer-blind poll
              </Text>
            </View>
          ) : null}

          {/* Attachments (Voice Notes / Files) */}
          {message.attachments && message.attachments.length > 0 ? (
            <View style={styles.attachmentsList}>
              {message.attachments.map((att) =>
                att.kind === 'voice_note' ||
                att.mimeType.startsWith('audio/') ? (
                  <VoiceNotePlayer key={att.id} attachment={att} />
                ) : (
                  <View key={att.id} style={styles.fileChip}>
                    <Ionicons
                      name="document-attach-outline"
                      size={16}
                      color={PALETTE.forest}
                    />
                    <Text style={styles.fileChipText} numberOfLines={1}>
                      {att.fileName}
                    </Text>
                  </View>
                )
              )}
            </View>
          ) : null}
        </View>
      )}

      {/* Reactions + Quick Actions Bar */}
      {!message.isDeleted &&
      (message.reactions.length > 0 ||
        (!isDmView && !isSelf && !!onMessagePrivately && !!message.senderPeerId) ||
        !!onReplyQuote) ? (
        <View style={styles.footerBar}>
          <View style={styles.reactionsWrap}>
            {message.reactions.map((rx) => (
              <Pressable
                key={rx.emoji}
                accessibilityRole="button"
                accessibilityLabel={`Reaction ${rx.emoji} count ${rx.count}`}
                onPress={() =>
                  onToggleReaction && onToggleReaction(message.id, rx.emoji)
                }
                style={[
                  styles.reactionPill,
                  rx.meReacted && styles.reactionPillActive,
                ]}
              >
                <Text style={styles.reactionEmoji}>{rx.emoji}</Text>
                <Text
                  style={[
                    styles.reactionCount,
                    rx.meReacted && styles.reactionCountActive,
                  ]}
                >
                  {rx.count}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.quickFooterActions}>
            {onReplyQuote ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Reply to ${message.senderAlias}`}
                onPress={() => onReplyQuote(message)}
                style={styles.quickReplyChip}
              >
                <Ionicons
                  name="return-down-forward-outline"
                  size={14}
                  color={PALETTE.ink}
                />
                <Text style={styles.quickReplyText}>Reply</Text>
              </Pressable>
            ) : null}

            {!isDmView &&
            !isSelf &&
            onMessagePrivately &&
            message.senderPeerId ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Message ${message.senderAlias} privately`}
                onPress={() =>
                  onMessagePrivately(message.senderPeerId, message.senderAlias)
                }
                style={styles.quickDmChip}
              >
                <Ionicons
                  name="lock-closed-outline"
                  size={13}
                  color={PALETTE.forest}
                />
                <Text style={styles.quickDmText}>DM</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  systemRow: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  systemPill: {
    backgroundColor: PALETTE.surfaceMuted,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
  },
  card: {
    backgroundColor: PALETTE.card,
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: PALETTE.border,
    gap: 8,
  },
  groupSelfCard: {
    borderColor: PALETTE.borderStrong,
  },
  dmBubbleSelf: {
    alignSelf: 'flex-end',
    width: '86%',
    backgroundColor: PALETTE.mintSoft,
    borderColor: PALETTE.mintBorder,
    borderBottomRightRadius: 4,
  },
  dmBubblePeer: {
    alignSelf: 'flex-start',
    width: '86%',
    backgroundColor: PALETTE.card,
    borderColor: PALETTE.border,
    borderBottomLeftRadius: 4,
  },
  icebreakerCard: {
    backgroundColor: PALETTE.mintSoft,
    borderColor: PALETTE.mintBorder,
  },
  governanceOuterCard: {
    borderColor: PALETTE.mintBorder,
    borderWidth: 1.5,
  },
  pinnedCard: {
    borderColor: PALETTE.forest,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  authorTapRow: {
    flex: 1,
    minHeight: TOUCH_MIN,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  avatarCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: PALETTE.card,
    fontWeight: '700',
    fontSize: 13,
    fontFamily: MONO_FONT,
  },
  headerMeta: {
    flex: 1,
    gap: 1,
  },
  aliasRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  aliasName: {
    fontSize: 14,
    fontWeight: '700',
  },
  youBadge: {
    backgroundColor: PALETTE.mint,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
  },
  youBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: PALETTE.charcoal,
    fontFamily: MONO_FONT,
  },
  pinBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
  },
  pinBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  savedBadge: {
    backgroundColor: PALETTE.surfaceMuted,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 5,
  },
  timestampText: {
    fontSize: 11,
    color: PALETTE.muted,
    fontFamily: MONO_FONT,
  },
  moreBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icebreakerBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  icebreakerLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.forest,
    letterSpacing: 0.6,
    fontFamily: MONO_FONT,
  },
  quoteBox: {
    borderLeftWidth: 3,
    borderLeftColor: PALETTE.forest,
    backgroundColor: PALETTE.surface,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 2,
  },
  quoteBoxOnMint: {
    backgroundColor: PALETTE.card,
  },
  quoteAuthor: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
  },
  quoteBody: {
    fontSize: 13,
    color: PALETTE.muted,
  },
  bodyWrap: {
    gap: 8,
  },
  deletedText: {
    fontSize: 14,
    fontStyle: 'italic',
    color: PALETTE.muted,
  },
  govCard: {
    backgroundColor: PALETTE.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    gap: 10,
  },
  govTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  govLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  govKindLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
    letterSpacing: 0.5,
  },
  govStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  govStatusOpen: {
    backgroundColor: PALETTE.mintSoft,
    borderColor: PALETTE.mintBorder,
  },
  govStatusPassed: {
    backgroundColor: PALETTE.mint,
    borderColor: PALETTE.forest,
  },
  govStatusRejected: {
    backgroundColor: PALETTE.dangerSoft,
    borderColor: '#f3c1bd',
  },
  govStatusText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: MONO_FONT,
  },
  govStatusTextOpen: {
    color: PALETTE.forest,
  },
  govStatusTextPassed: {
    color: PALETTE.charcoal,
  },
  govStatusTextRejected: {
    color: PALETTE.danger,
  },
  govTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  govReason: {
    fontSize: 13,
    color: PALETTE.muted,
    lineHeight: 18,
  },
  govTallyBox: {
    gap: 5,
  },
  govCountsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  govYesStat: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  govEligibleStat: {
    fontSize: 11,
    color: PALETTE.muted,
    fontFamily: MONO_FONT,
  },
  govNoStat: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.danger,
    fontFamily: MONO_FONT,
  },
  govTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: PALETTE.surfaceMuted,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  govYesBar: {
    backgroundColor: PALETTE.forest,
    height: '100%',
  },
  govNoBar: {
    backgroundColor: PALETTE.danger,
    height: '100%',
  },
  govAliasesText: {
    fontSize: 11,
    color: PALETTE.muted,
  },
  govButtonsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  govVoteYesBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
  },
  govVoteYesBtnActive: {
    backgroundColor: PALETTE.mint,
    borderWidth: 1.5,
  },
  govVoteYesText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  govVoteNoBtn: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    backgroundColor: PALETTE.card,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 10,
  },
  govVoteNoBtnActive: {
    backgroundColor: PALETTE.dangerSoft,
    borderColor: PALETTE.danger,
    borderWidth: 1.5,
  },
  govVoteNoText: {
    fontSize: 13,
    fontWeight: '700',
    color: PALETTE.ink,
  },
  govVoteNoTextActive: {
    color: PALETTE.danger,
  },
  govFooterText: {
    fontSize: 11,
    color: PALETTE.muted,
    fontFamily: MONO_FONT,
  },
  pollCard: {
    backgroundColor: PALETTE.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    gap: 10,
  },
  pollHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pollQuestion: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: PALETTE.charcoal,
  },
  pollOptionsList: {
    gap: 8,
  },
  pollOptionBtn: {
    minHeight: TOUCH_MIN,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: PALETTE.borderStrong,
    backgroundColor: PALETTE.card,
    overflow: 'hidden',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    position: 'relative',
  },
  pollOptionVoted: {
    borderColor: PALETTE.forest,
    borderWidth: 1.5,
  },
  pollFillBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: PALETTE.mintSoft,
  },
  pollOptionContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  pollLabelWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  pollOptionLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: PALETTE.ink,
    flex: 1,
  },
  pollVoteCount: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
  pollVotersText: {
    fontSize: 11,
    color: PALETTE.muted,
    marginTop: 3,
    marginLeft: 26,
  },
  pollFooter: {
    fontSize: 11,
    color: PALETTE.muted,
    fontFamily: MONO_FONT,
  },
  attachmentsList: {
    gap: 6,
  },
  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: PALETTE.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  fileChipText: {
    fontSize: 13,
    color: PALETTE.ink,
    flex: 1,
  },
  footerBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 2,
  },
  reactionsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  reactionPill: {
    minHeight: TOUCH_MIN,
    minWidth: TOUCH_MIN,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  reactionPillActive: {
    backgroundColor: PALETTE.mintSoft,
    borderColor: PALETTE.forest,
  },
  reactionEmoji: {
    fontSize: 15,
  },
  reactionCount: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.ink,
    fontFamily: MONO_FONT,
  },
  reactionCountActive: {
    color: PALETTE.forest,
  },
  quickFooterActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
  },
  quickReplyChip: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  quickReplyText: {
    fontSize: 12,
    fontWeight: '600',
    color: PALETTE.ink,
  },
  quickDmChip: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: PALETTE.mintSoft,
    borderWidth: 1,
    borderColor: PALETTE.mintBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  quickDmText: {
    fontSize: 12,
    fontWeight: '700',
    color: PALETTE.forest,
    fontFamily: MONO_FONT,
  },
});

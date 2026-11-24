import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../theme/ui';
import { Ionicons } from '@expo/vector-icons';
import type { RichMessageDto } from '../types/canopy';
import { PIECES, TOUCH_MIN, pieceColor } from '../theme/palette';
import { Piece } from './Pieces';
import { RichTextBody } from './RichTextBody';
import { VoiceNotePlayer } from './VoiceNotePlayer';

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
  peerLastReadMessageId?: number;
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
  peerLastReadMessageId = 0,
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
          <RichTextBody body={message.body} compactSystem />
        </View>
      </View>
    );
  }

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

  // Every bubble is the sender's alias colour. In a private chat your own
  // bubbles are blue with white type, the one place blue marks "yours".
  const onBlue = isDmView && isSelf;
  const bubbleColor = onBlue ? PIECES.blue : pieceColor(message.senderAlias);
  const textColor = onBlue ? PIECES.sheet : PIECES.ink;
  const subColor = onBlue ? 'rgba(255,255,255,0.86)' : PIECES.ink2;

  const totalPollVotes = message.poll
    ? message.poll.options.reduce((acc, opt) => acc + opt.votes, 0)
    : 0;
  const hasFooter =
    !message.isDeleted &&
    (message.reactions.length > 0 ||
      (!isDmView && !isSelf && !!onMessagePrivately && !!message.senderPeerId) ||
      !!onReplyQuote);

  return (
    <View
      style={[
        styles.row,
        isSelf ? styles.rowSelf : styles.rowPeer,
      ]}
    >
      <Pressable
        onLongPress={
          onOpenActions && !message.isDeleted
            ? () => onOpenActions(message)
            : undefined
        }
        delayLongPress={260}
        style={[
          styles.bubble,
          isSelf ? styles.bubbleSelf : styles.bubblePeer,
          { backgroundColor: bubbleColor },
          isGovernance && styles.bubbleWide,
          message.isPinned && styles.bubblePinned,
        ]}
      >
        <View style={styles.headerRow}>
          <Pressable
            accessibilityRole={canDmSender ? 'button' : undefined}
            accessibilityLabel={
              canDmSender
                ? `${message.senderAlias}. Options, including write privately`
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
            <Text style={[styles.aliasName, { color: textColor }]} numberOfLines={1}>
              {isSelf ? 'You' : message.senderAlias}
            </Text>
            <Text style={[styles.timestampText, { color: subColor }]}>
              {formatShortTime(message.createdAt)}
              {message.editedAt ? ' · edited' : ''}
            </Text>
            {message.isPinned ? (
              <Ionicons name="pin" size={13} color={textColor} />
            ) : null}
            {message.isBookmarked ? (
              <Ionicons name="bookmark" size={13} color={textColor} />
            ) : null}
          </Pressable>

          {onOpenActions && !message.isDeleted ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`More for the message from ${message.senderAlias}`}
              onPress={() => onOpenActions(message)}
              style={styles.moreBtn}
            >
              <Ionicons name="ellipsis-horizontal" size={18} color={textColor} />
            </Pressable>
          ) : null}
        </View>

        {isIcebreaker ? (
          <Text style={[styles.kicker, { color: subColor }]}>Icebreaker</Text>
        ) : null}

        {message.quoteMessage ? (
          <View style={styles.quoteBox}>
            <Text style={styles.quoteAuthor}>
              {message.quoteMessage.senderAlias}
            </Text>
            <Text style={styles.quoteBody} numberOfLines={2}>
              {message.quoteMessage.isDeleted
                ? 'Removed message'
                : message.quoteMessage.body || 'Voice note or file'}
            </Text>
          </View>
        ) : null}

        {message.isDeleted ? (
          <Text style={[styles.deletedText, { color: subColor }]}>
            This message was removed.
          </Text>
        ) : (
          <View style={styles.bodyWrap}>
            {message.body &&
            message.msgType !== 'POLL' &&
            message.msgType !== 'VOICE_NOTE' &&
            !isGovernance ? (
              <RichTextBody body={message.body} color={textColor} />
            ) : null}

            {/* A room vote: Yes against No, more Yes than No wins */}
            {proposal ? (
              <View style={styles.voteBox}>
                <Text style={styles.voteTitle}>{proposal.title}</Text>
                {proposal.reason ? (
                  <Text style={styles.voteSub}>Reason: {proposal.reason}</Text>
                ) : null}

                {(
                  [
                    { label: 'Yes', n: proposal.yesCount, mine: proposal.myVote === true, vote: true },
                    { label: 'No', n: proposal.noCount, mine: proposal.myVote === false, vote: false },
                  ] as const
                ).map((row) => {
                  const pct =
                    proposal.eligibleCount > 0
                      ? Math.min(100, Math.round((row.n / proposal.eligibleCount) * 100))
                      : 0;
                  return (
                    <Pressable
                      key={row.label}
                      accessibilityRole="button"
                      accessibilityLabel={`Vote ${row.label} on ${proposal.title}. ${row.n} so far`}
                      accessibilityState={{ selected: row.mine, disabled: proposal.status !== 'OPEN' }}
                      disabled={!onVoteProposal || proposal.status !== 'OPEN'}
                      onPress={() => onVoteProposal && onVoteProposal(proposal.id, row.vote)}
                      style={[styles.voteRow, row.mine && styles.voteRowMine]}
                    >
                      <View style={[styles.voteFill, { width: `${pct}%` }]} />
                      <Text style={styles.voteLabel}>
                        {row.mine ? `${row.label} (yours)` : row.label}
                      </Text>
                      <Text style={styles.voteCount}>{row.n}</Text>
                    </Pressable>
                  );
                })}

                <Text style={styles.voteSub}>
                  {proposal.status === 'OPEN'
                    ? 'More Yes than No wins.'
                    : proposal.status === 'PASSED'
                    ? 'It passed.'
                    : 'It did not pass.'}{' '}
                  {proposal.eligibleCount - proposal.yesCount - proposal.noCount > 0
                    ? `${proposal.eligibleCount - proposal.yesCount - proposal.noCount} still to vote.`
                    : ''}
                </Text>
                {proposal.yesAliases.length > 0 ? (
                  <Text style={styles.voteSub} numberOfLines={1}>
                    Yes: {proposal.yesAliases.join(', ')}
                  </Text>
                ) : null}
                {proposal.noAliases.length > 0 ? (
                  <Text style={styles.voteSub} numberOfLines={1}>
                    No: {proposal.noAliases.join(', ')}
                  </Text>
                ) : null}
                <Text style={styles.voteSub}>Asked by {proposal.proposerAlias}</Text>
              </View>
            ) : null}

            {/* A /poll: same bars, any number of options */}
            {message.poll ? (
              <View style={styles.voteBox}>
                <Text style={styles.voteTitle}>{message.poll.question}</Text>
                {message.poll.options.map((opt) => {
                  const pct =
                    totalPollVotes > 0
                      ? Math.round((opt.votes / totalPollVotes) * 100)
                      : 0;
                  return (
                    <Pressable
                      key={opt.index}
                      accessibilityRole="button"
                      accessibilityLabel={`Vote ${opt.label}. ${opt.votes} so far`}
                      accessibilityState={{ selected: opt.meVoted, disabled: !!message.poll?.isClosed }}
                      disabled={message.poll?.isClosed || !onVotePoll}
                      onPress={() =>
                        message.poll &&
                        onVotePoll &&
                        onVotePoll(message.poll.pollId, opt.index)
                      }
                      style={[styles.voteRow, opt.meVoted && styles.voteRowMine]}
                    >
                      <View style={[styles.voteFill, { width: `${pct}%` }]} />
                      <Text style={styles.voteLabel} numberOfLines={1}>
                        {opt.meVoted ? `${opt.label} (yours)` : opt.label}
                      </Text>
                      <Text style={styles.voteCount}>{opt.votes}</Text>
                    </Pressable>
                  );
                })}
                <Text style={styles.voteSub}>
                  {totalPollVotes} {totalPollVotes === 1 ? 'vote' : 'votes'}
                  {message.poll.isClosed ? ' · closed' : ''}
                </Text>
              </View>
            ) : null}

            {message.attachments && message.attachments.length > 0 ? (
              <View style={styles.attachmentsList}>
                {message.attachments.map((att) =>
                  att.kind === 'voice_note' ||
                  att.mimeType.startsWith('audio/') ? (
                    <VoiceNotePlayer key={att.id} attachment={att} />
                  ) : (
                    <View key={att.id} style={styles.fileChip}>
                      <Text style={styles.fileChipText} numberOfLines={1}>
                        {att.fileName}
                      </Text>
                      <Text style={styles.fileSize}>
                        {att.sizeBytes < 1024
                          ? `${att.sizeBytes} B`
                          : `${Math.round(att.sizeBytes / 1024)} KB`}
                      </Text>
                    </View>
                  )
                )}
              </View>
            ) : null}
          </View>
        )}

        {/* Seen receipts: sent is one tick, seen is two */}
        {isDmView && isSelf && !message.isDeleted ? (
          <Text style={[styles.receipt, { color: subColor }]}>
            {message.id <= peerLastReadMessageId ? '✓✓ Seen' : '✓ Sent'}
          </Text>
        ) : null}

        {hasFooter ? (
          <View style={styles.footerBar}>
            {message.reactions.map((rx) => (
              <Pressable
                key={rx.emoji}
                accessibilityRole="button"
                accessibilityLabel={`${rx.emoji}, ${rx.count}${rx.meReacted ? ', you reacted' : ''}`}
                accessibilityState={{ selected: rx.meReacted }}
                onPress={() =>
                  onToggleReaction && onToggleReaction(message.id, rx.emoji)
                }
                style={[styles.reactionPill, rx.meReacted && styles.reactionPillActive]}
              >
                <Text style={styles.reactionEmoji}>{rx.emoji}</Text>
                <Text
                  style={[styles.reactionCount, rx.meReacted && styles.reactionCountActive]}
                >
                  {rx.count}
                </Text>
              </Pressable>
            ))}

            {onReplyQuote ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Reply to ${message.senderAlias}`}
                onPress={() => onReplyQuote(message)}
                style={styles.quickChip}
              >
                <Text style={styles.quickChipText}>Reply</Text>
              </Pressable>
            ) : null}

            {!isDmView &&
            !isSelf &&
            onMessagePrivately &&
            message.senderPeerId ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Write to ${message.senderAlias} privately`}
                onPress={() =>
                  onMessagePrivately(message.senderPeerId, message.senderAlias)
                }
                style={styles.quickChip}
              >
                <Text style={styles.quickChipText}>Write privately</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  systemRow: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  systemPill: {
    backgroundColor: PIECES.glass,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    maxWidth: '94%',
  },
  row: { flexDirection: 'row' },
  rowSelf: { justifyContent: 'flex-end' },
  rowPeer: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '88%',
    minWidth: 120,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 12,
    gap: 6,
    borderRadius: 24,
  },
  // The tail: one square corner on the side the sender sits.
  bubblePeer: { borderBottomLeftRadius: 0 },
  bubbleSelf: { borderBottomRightRadius: 0 },
  bubbleWide: { width: '88%' },
  bubblePinned: { borderWidth: 3, borderColor: PIECES.ink },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
  },
  authorTapRow: {
    flex: 1,
    minHeight: TOUCH_MIN,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  aliasName: { fontSize: 14, fontWeight: '700', flexShrink: 1 },
  timestampText: { fontSize: 13, fontFamily: 'DMMono_400Regular' },
  moreBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    marginRight: -10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kicker: { fontSize: 13, fontFamily: 'DMMono_500Medium', marginTop: -6 },
  quoteBox: {
    backgroundColor: PIECES.glass,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 2,
  },
  quoteAuthor: { fontSize: 13, fontWeight: '700', color: PIECES.ink },
  quoteBody: { fontSize: 14, color: PIECES.ink2 },
  deletedText: { fontSize: 15, fontStyle: 'italic' },
  bodyWrap: { gap: 10 },
  voteBox: { gap: 8, marginTop: 2 },
  voteTitle: { fontSize: 21, lineHeight: 25, color: PIECES.ink, fontWeight: '600' },
  voteSub: { fontSize: 13, lineHeight: 18, color: PIECES.ink2 },
  voteRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderRadius: 22,
    backgroundColor: 'rgba(17,17,17,0.16)',
    overflow: 'hidden',
  },
  voteRowMine: { borderWidth: 3, borderColor: PIECES.ink },
  voteFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: PIECES.glass,
  },
  voteLabel: { flex: 1, fontSize: 16, fontWeight: '600', color: PIECES.ink },
  voteCount: { fontSize: 16, fontFamily: 'DMMono_500Medium', color: PIECES.ink },
  attachmentsList: { gap: 8 },
  fileChip: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: PIECES.glass,
    borderRadius: 16,
    paddingHorizontal: 14,
  },
  fileChipText: { flex: 1, fontSize: 15, fontWeight: '600', color: PIECES.ink },
  fileSize: { fontSize: 13, fontFamily: 'DMMono_400Regular', color: PIECES.ink2 },
  receipt: { fontSize: 13, fontFamily: 'DMMono_500Medium' },
  footerBar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  reactionPill: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: PIECES.glass,
  },
  reactionPillActive: { backgroundColor: PIECES.ink },
  reactionEmoji: { fontSize: 15 },
  reactionCount: { fontSize: 14, fontWeight: '700', color: PIECES.ink },
  reactionCountActive: { color: PIECES.sheet },
  quickChip: {
    minHeight: TOUCH_MIN,
    paddingHorizontal: 14,
    borderRadius: 22,
    backgroundColor: PIECES.glass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickChipText: { fontSize: 14, fontWeight: '600', color: PIECES.ink },
});

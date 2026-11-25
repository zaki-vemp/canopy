import React from 'react';
import { Image, Linking, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../theme/ui';
import { Ionicons } from '@expo/vector-icons';
import type { RichMessageDto } from '../types/canopy';
import { buildAttachmentUrl } from '../api/client';
import { PIECES, TOUCH_MIN, pieceColor } from '../theme/palette';
import { RichTextBody } from './RichTextBody';
import { VoiceNotePlayer } from './VoiceNotePlayer';

function formatShortTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// The server says "pod"; people read "room". Same rule as frontend/src/lib/stream.ts.
function serverWords(text: string): string {
  return text.replace(/\bpod\b/i, (m) => (m[0] === 'P' ? 'Room' : 'room'));
}

const RUN_GAP_MS = 5 * 60_000;

// Same person, again, within five minutes: the name is already on screen.
export function continuesRun(prev: RichMessageDto | undefined, msg: RichMessageDto): boolean {
  if (!prev || prev.senderPeerId !== msg.senderPeerId) return false;
  const plain = (m: RichMessageDto) => m.msgType === 'TEXT' || m.msgType === 'VOICE_NOTE';
  if (!plain(prev) || !plain(msg)) return false;
  return Date.parse(msg.createdAt) - Date.parse(prev.createdAt) < RUN_GAP_MS;
}

export interface MessageCardProps {
  message: RichMessageDto;
  /** Follows a message from the same person, so it sits closer and drops the name. */
  continues?: boolean;
  myPeerId?: string;
  isDmView?: boolean;
  peerLastReadMessageId?: number;
  onOpenActions?: (message: RichMessageDto) => void;
  onToggleReaction?: (messageId: number, emoji: string) => void;
  onVotePoll?: (pollId: number, optionIndex: number) => void;
  onClosePoll?: (pollId: number) => void;
  canClosePoll?: boolean;
  onVoteProposal?: (proposalId: number, vote: boolean) => void;
}

export function MessageCard({
  message,
  continues = false,
  myPeerId,
  isDmView = false,
  peerLastReadMessageId = 0,
  onOpenActions,
  onToggleReaction,
  onVotePoll,
  onClosePoll,
  canClosePoll = false,
  onVoteProposal,
}: MessageCardProps) {
  if (message.msgType === 'SYSTEM') {
    return (
      <View style={styles.systemRow}>
        <View style={styles.systemPill}>
          <RichTextBody body={serverWords(message.body)} compactSystem />
        </View>
      </View>
    );
  }

  const isSelf = !!myPeerId && message.senderPeerId === myPeerId;
  const isIcebreaker = message.msgType === 'ICEBREAKER';
  const isGovernance = message.msgType === 'GOVERNANCE' && !!message.proposal;
  const isVote = isGovernance || !!message.poll;
  const proposal = message.proposal ?? null;
  const showName = !isSelf && !isDmView && !continues;

  // Every bubble is the sender's alias colour. In a private chat your own
  // bubbles are blue with white type, the one place blue marks "yours".
  const onBlue = isDmView && isSelf;
  const bubbleColor = onBlue ? PIECES.blue : pieceColor(message.senderAlias);
  const textColor = onBlue ? PIECES.sheet : PIECES.ink;
  const subColor = onBlue ? 'rgba(255,255,255,0.86)' : PIECES.ink2;

  const totalPollVotes = message.poll
    ? message.poll.options.reduce((acc, opt) => acc + opt.votes, 0)
    : 0;
  const hasControls =
    !!message.poll ||
    !!proposal ||
    message.reactions.length > 0 ||
    message.attachments.length > 0 ||
    message.body.includes('||');
  const openActions =
    onOpenActions && !message.isDeleted ? () => onOpenActions(message) : undefined;
  const time = `${formatShortTime(message.createdAt)}${message.editedAt ? ' · edited' : ''}`;
  const receipt =
    isDmView && isSelf && !message.isDeleted
      ? message.id <= peerLastReadMessageId
        ? '✓✓ Seen'
        : '✓ Sent'
      : null;

  return (
    <View
      style={[
        styles.row,
        isSelf ? styles.rowSelf : styles.rowPeer,
        continues && styles.rowContinues,
      ]}
    >
      <Pressable
        // A bubble that is one button would hide the buttons inside it from screen readers.
        accessible={!hasControls}
        accessibilityRole={openActions && !hasControls ? 'button' : undefined}
        accessibilityHint={openActions ? 'Reply, react, save or write privately' : undefined}
        disabled={!openActions}
        onPress={openActions}
        onLongPress={openActions}
        delayLongPress={260}
        style={[
          styles.bubble,
          isSelf ? styles.bubbleSelf : styles.bubblePeer,
          { backgroundColor: bubbleColor },
          isVote && styles.bubbleWide,
          message.isPinned && styles.bubblePinned,
        ]}
      >
        {showName ? (
          <Text style={[styles.aliasName, { color: textColor }]} numberOfLines={1}>
            {message.senderAlias}
          </Text>
        ) : null}

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

        <View style={styles.flow}>
        <View style={[styles.flowBody, isVote && styles.flowBodyWide]}>
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
                <View style={styles.pollFooterRow}>
                  <Text style={styles.voteSub}>
                    {totalPollVotes} {totalPollVotes === 1 ? 'vote' : 'votes'}
                    {message.poll.isClosed ? ' · closed' : ''}
                  </Text>
                  {canClosePoll && !message.poll.isClosed && onClosePoll ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Close poll"
                      onPress={() => message.poll && onClosePoll(message.poll.pollId)}
                      style={styles.closePollBtn}
                    >
                      <Text style={styles.closePollText}>Close poll</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            ) : null}

            {message.attachments && message.attachments.length > 0 ? (
              <View style={styles.attachmentsList}>
                {message.attachments.map((att) =>
                  att.kind === 'voice_note' ||
                  att.mimeType.startsWith('audio/') ? (
                    <VoiceNotePlayer key={att.id} attachment={att} />
                  ) : att.kind === 'image' || att.mimeType.startsWith('image/') ? (
                    <Pressable
                      key={att.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Open image ${att.fileName}`}
                      onPress={() => Linking.openURL(buildAttachmentUrl(att.url)).catch(() => {})}
                    >
                      <Image
                        source={{ uri: buildAttachmentUrl(att.url) }}
                        accessibilityLabel={att.fileName}
                        style={styles.imagePreview}
                        resizeMode="cover"
                      />
                    </Pressable>
                  ) : (
                    <Pressable
                      key={att.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Open file ${att.fileName}`}
                      onPress={() => Linking.openURL(buildAttachmentUrl(att.url)).catch(() => {})}
                      style={styles.fileChip}
                    >
                      <Text style={styles.fileChipText} numberOfLines={1}>
                        {att.fileName}
                      </Text>
                      <Text style={styles.fileSize}>
                        {att.sizeBytes < 1024
                          ? `${att.sizeBytes} B`
                          : `${Math.round(att.sizeBytes / 1024)} KB`}
                      </Text>
                    </Pressable>
                  )
                )}
              </View>
            ) : null}
          </View>
        )}

        {message.reactions.length > 0 && !message.isDeleted ? (
          <View style={styles.footerBar}>
            {message.reactions.map((rx) => (
              <Pressable
                key={rx.emoji}
                accessibilityRole="button"
                accessibilityLabel={`${rx.emoji}, ${rx.count}${rx.meReacted ? ', you reacted' : ''}`}
                accessibilityState={{ selected: rx.meReacted }}
                hitSlop={6}
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
          </View>
        ) : null}
        </View>

        {/* When, and in a private chat whether it was seen. Short messages keep it on their line. */}
        <View style={styles.metaRow}>
          {message.isPinned ? <Ionicons name="pin" size={12} color={subColor} /> : null}
          {message.isBookmarked ? (
            <Ionicons name="bookmark" size={12} color={subColor} />
          ) : null}
          <Text style={[styles.metaText, { color: subColor }]}>
            {time}
            {receipt ? ` ${receipt}` : ''}
          </Text>
        </View>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  systemRow: {
    alignItems: 'center',
    marginTop: 8,
  },
  systemPill: {
    backgroundColor: PIECES.glass,
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 16,
    maxWidth: '94%',
  },
  row: { flexDirection: 'row', marginTop: 10 },
  rowContinues: { marginTop: 3 },
  rowSelf: { justifyContent: 'flex-end' },
  rowPeer: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '86%',
    minHeight: TOUCH_MIN,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
    gap: 4,
    borderRadius: 20,
  },
  // The tail: one square corner on the side the sender sits.
  bubblePeer: { borderBottomLeftRadius: 0 },
  bubbleSelf: { borderBottomRightRadius: 0 },
  bubbleWide: { width: '86%' },
  bubblePinned: { borderWidth: 3, borderColor: PIECES.ink },
  aliasName: { fontSize: 14, lineHeight: 18, fontWeight: '700' },
  flow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    columnGap: 10,
  },
  flowBody: { flexGrow: 1, flexShrink: 1, gap: 6 },
  flowBodyWide: { flexBasis: '100%' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 18 },
  metaText: { fontSize: 12, lineHeight: 16, fontFamily: 'DMMono_400Regular' },
  kicker: { fontSize: 13, fontFamily: 'DMMono_500Medium' },
  quoteBox: {
    backgroundColor: PIECES.glass,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 2,
    marginBottom: 2,
  },
  quoteAuthor: { fontSize: 13, fontWeight: '700', color: PIECES.ink },
  quoteBody: { fontSize: 14, color: PIECES.ink2 },
  deletedText: { fontSize: 15, fontStyle: 'italic' },
  bodyWrap: { gap: 10 },
  voteBox: { gap: 8, marginTop: 2 },
  voteTitle: { fontSize: 19, lineHeight: 23, color: PIECES.ink, fontWeight: '600' },
  voteSub: { fontSize: 13, lineHeight: 18, color: PIECES.ink2 },
  voteRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
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
  pollFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  closePollBtn: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: PIECES.glass,
    justifyContent: 'center',
  },
  closePollText: { fontSize: 13, fontWeight: '600', color: PIECES.ink },
  attachmentsList: { gap: 8 },
  imagePreview: {
    width: '100%',
    height: 180,
    borderRadius: 16,
    backgroundColor: PIECES.glass,
  },
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
  footerBar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  reactionPill: {
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    borderRadius: 16,
    backgroundColor: PIECES.glass,
  },
  reactionPillActive: { backgroundColor: PIECES.ink },
  reactionEmoji: { fontSize: 15 },
  reactionCount: { fontSize: 14, fontWeight: '700', color: PIECES.ink },
  reactionCountActive: { color: PIECES.sheet },
});

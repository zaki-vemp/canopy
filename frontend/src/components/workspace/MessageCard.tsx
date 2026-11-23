'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAtom, useSetAtom } from 'jotai';
import {
  Bookmark,
  Check,
  Clock,
  CornerUpLeft,
  Download,
  MessageCircle,
  Pause,
  Pencil,
  Pin,
  Play,
  Scale,
  SmilePlus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { ApiError, apiFetch, buildAttachmentUrl } from '@/lib/api';
import {
  activeDmPeerByPodAtom,
  activePodIdAtom,
  highlightedMessageIdAtom,
  quoteTargetByConvoAtom,
  rightPanelAtom,
  unreadByConvoAtom,
} from '@/state/workspaceAtoms';
import {
  markMessageDeletedInCaches,
  patchMessageAcrossCaches,
  syncProposalIntoCaches,
} from '@/state/wsPodClient';
import {
  RichMarkdown,
  aliasInitials,
  safeAvatarColor,
} from '@/components/workspace/markdown';
import {
  conversationKey,
  resolveMessagePeerId,
  type AttachmentItem,
  type PodDetail,
  type PodProposalDto,
  type PollData,
  type RichMessage,
} from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

const QUICK_EMOJIS = ['👍', '🔥', '😂', '🎯', '❤️'];
const EXTRA_EMOJIS = ['🎉', '👀', '🙌', '⚡', '🤝', '✅'];

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const whole = Math.round(sec);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatProposalTiming(proposal: PodProposalDto, nowMs: number): string {
  if (proposal.status !== 'OPEN') {
    return proposal.resolvedAt
      ? `Resolved ${formatClock(proposal.resolvedAt)}`
      : proposal.status === 'PASSED'
        ? 'Executed immediately'
        : 'Closed';
  }
  const expMs = Date.parse(proposal.expiresAt);
  if (Number.isNaN(expMs)) return 'Open vote';
  const diffSec = Math.round((expMs - nowMs) / 1000);
  if (diffSec <= 0) return 'Vote window ended · Ready to finalize';
  if (diffSec < 60) return `${diffSec}s left`;
  const mins = Math.ceil(diffSec / 60);
  return `~${mins}m left`;
}

export function PodProposalVoteCard({
  proposal,
  podId,
  compact = false,
}: {
  proposal: PodProposalDto;
  podId: string;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [voteErr, setVoteErr] = useState<string | null>(null);

  useEffect(() => {
    if (proposal.status !== 'OPEN') return;
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, [proposal.status]);

  const castVoteMutation = useMutation({
    mutationFn: (vote: boolean) =>
      apiFetch<{ proposal: PodProposalDto; pod?: PodDetail | null }>(
        `/api/proposals/${proposal.id}/vote`,
        {
          method: 'POST',
          body: JSON.stringify({ vote }),
        }
      ),
    onSuccess: (res) => {
      setVoteErr(null);
      syncProposalIntoCaches(queryClient, podId, res.proposal, res.pod);
      queryClient.invalidateQueries({ queryKey: ['pods'] });
    },
    onError: (err: Error) => {
      setVoteErr(err.message || 'Could not record vote');
    },
  });

  const resolveMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ proposal: PodProposalDto; pod?: PodDetail | null }>(
        `/api/proposals/${proposal.id}/resolve`,
        { method: 'POST' }
      ),
    onSuccess: (res) => {
      setVoteErr(null);
      syncProposalIntoCaches(queryClient, podId, res.proposal, res.pod);
      queryClient.invalidateQueries({ queryKey: ['pods'] });
    },
    onError: (err: Error) => {
      setVoteErr(err.message || 'Could not finalize vote');
    },
  });

  const yesCount = proposal.yesCount ?? 0;
  const noCount = proposal.noCount ?? 0;
  const totalCast = yesCount + noCount;
  const yesPct = totalCast > 0 ? Math.round((yesCount / totalCast) * 100) : 50;
  const expMs = Date.parse(proposal.expiresAt);
  const isExpiredOpen =
    proposal.status === 'OPEN' && !Number.isNaN(expMs) && expMs <= nowMs;
  const busy = castVoteMutation.isPending || resolveMutation.isPending;

  const yesAliases = proposal.yesAliases || [];
  const noAliases = proposal.noAliases || [];

  return (
    <div
      className={`${styles.governanceCard} ${
        proposal.status === 'PASSED'
          ? styles.governanceCardPassed
          : proposal.status === 'REJECTED'
            ? styles.governanceCardRejected
            : ''
      }`}
      style={compact ? { maxWidth: '100%' } : undefined}
      role="group"
      aria-label={`Pod governance proposal: ${proposal.title}`}
    >
      <div className={styles.governanceTopRow}>
        <span
          className={`${styles.governanceStatusBadge} ${
            proposal.status === 'PASSED'
              ? styles.governanceStatusPassed
              : proposal.status === 'REJECTED'
                ? styles.governanceStatusRejected
                : styles.governanceStatusOpen
          }`}
        >
          <Scale size={12} />
          <span>
            {proposal.status === 'OPEN'
              ? 'POD VOTE · OPEN'
              : proposal.status === 'PASSED'
                ? 'PASSED ✓'
                : 'REJECTED ✕'}
          </span>
        </span>

        <span className={styles.governanceTimer}>
          <Clock size={11} />
          <span>{formatProposalTiming(proposal, nowMs)}</span>
        </span>
      </div>

      <div className={styles.governanceTitle}>{proposal.title}</div>

      <div className={styles.governanceSubline}>
        Proposed by <strong>{proposal.proposerAlias}</strong> ·{' '}
        <span>Eligible seats: {proposal.eligibleCount}</span>
      </div>

      {proposal.reason && (
        <div className={styles.governanceReason}>
          Reason: “{proposal.reason}”
        </div>
      )}

      <div className={styles.governanceTallyHeader}>
        <span style={{ color: '#154726', fontWeight: 700 }}>
          YES: {yesCount}
        </span>
        <span className={styles.governanceRuleTag}>Rule: YES &gt; NO wins</span>
        <span style={{ color: '#912018', fontWeight: 700 }}>NO: {noCount}</span>
      </div>

      <div className={styles.governanceBarTrack} aria-hidden="true">
        <div
          className={styles.governanceBarYes}
          style={{ width: totalCast === 0 ? '0%' : `${yesPct}%` }}
        />
        <div
          className={styles.governanceBarNo}
          style={{ width: totalCast === 0 ? '0%' : `${100 - yesPct}%` }}
        />
      </div>

      {(yesAliases.length > 0 || noAliases.length > 0) && (
        <div className={styles.governanceVotersBox}>
          {yesAliases.length > 0 && (
            <div>
              <strong>YES:</strong> {yesAliases.join(', ')}
            </div>
          )}
          {noAliases.length > 0 && (
            <div>
              <strong>NO:</strong> {noAliases.join(', ')}
            </div>
          )}
        </div>
      )}

      {voteErr && (
        <div
          style={{
            marginTop: 8,
            padding: '6px 9px',
            borderRadius: 7,
            background: '#fef3f2',
            color: '#b42318',
            fontSize: 12,
          }}
          role="alert"
        >
          {voteErr}
        </div>
      )}

      {proposal.status === 'OPEN' && (
        <div className={styles.governanceBtnRow}>
          <button
            type="button"
            disabled={busy}
            onClick={() => castVoteMutation.mutate(true)}
            aria-pressed={proposal.myVote === true}
            className={`${styles.govVoteYesBtn} ${
              proposal.myVote === true ? styles.govVoteYesBtnActive : ''
            }`}
          >
            <Check size={15} />
            <span>
              {proposal.myVote === true ? 'Voted YES' : 'Vote YES'} ({yesCount})
            </span>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => castVoteMutation.mutate(false)}
            aria-pressed={proposal.myVote === false}
            className={`${styles.govVoteNoBtn} ${
              proposal.myVote === false ? styles.govVoteNoBtnActive : ''
            }`}
          >
            <X size={15} />
            <span>
              {proposal.myVote === false ? 'Voted NO' : 'Vote NO'} ({noCount})
            </span>
          </button>
        </div>
      )}

      {isExpiredOpen && (
        <button
          type="button"
          disabled={busy}
          onClick={() => resolveMutation.mutate()}
          className={styles.govFinalizeBtn}
        >
          {resolveMutation.isPending
            ? 'Finalizing vote...'
            : 'Finalize expired vote'}
        </button>
      )}
    </div>
  );
}

function VoiceNotePlayer({ attachment }: { attachment: AttachmentItem }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(
    attachment.durationMs > 0 ? attachment.durationMs / 1000 : 0
  );

  const barHeights = useMemo(() => {
    const bars: number[] = [];
    let seed = (attachment.id || 7) * 2654435761;
    for (let i = 0; i < 28; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const pct = 26 + (seed % 70);
      bars.push(pct);
    }
    return bars;
  }, [attachment.id]);

  const src = buildAttachmentUrl(attachment.url);
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
    } else {
      el.play().catch(() => {});
    }
  };

  const handleScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * duration;
    setCurrentTime(el.currentTime);
  };

  return (
    <div className={styles.voiceNoteCard}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrentTime(0);
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
      />

      <button
        type="button"
        className={styles.voicePlayBtn}
        onClick={togglePlay}
        aria-label={playing ? 'Pause voice note' : 'Play voice note'}
      >
        {playing ? <Pause size={17} /> : <Play size={17} />}
      </button>

      <div
        className={styles.waveformBars}
        onClick={handleScrub}
        role="slider"
        aria-label="Voice note waveform scrubber"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        tabIndex={0}
      >
        {barHeights.map((h, idx) => {
          const barRatio = (idx + 1) / barHeights.length;
          const played = progress >= barRatio || (playing && idx === 0);
          return (
            <span
              key={idx}
              className={`${styles.waveBar} ${played ? styles.waveBarPlayed : ''}`}
              style={{ height: `${h}%` }}
            />
          );
        })}
      </div>

      <span className={styles.voiceDuration}>
        {playing || currentTime > 0
          ? `${formatSeconds(currentTime)} / ${formatSeconds(duration)}`
          : formatSeconds(duration)}
      </span>
    </div>
  );
}

function InteractivePoll({
  poll,
  podId,
}: {
  poll: PollData;
  podId: string;
}) {
  const queryClient = useQueryClient();
  const totalVotes = poll.options.reduce((acc, o) => acc + o.votes, 0);

  const voteMutation = useMutation({
    mutationFn: (optionIndex: number) =>
      apiFetch<{ message: RichMessage }>(`/api/polls/${poll.pollId}/vote`, {
        method: 'POST',
        body: JSON.stringify({ optionIndex }),
      }),
    onSuccess: (res) => {
      if (res?.message) {
        patchMessageAcrossCaches(queryClient, podId, res.message, true);
      }
    },
  });

  return (
    <div
      className={styles.pollCard}
      role="group"
      aria-label={`Poll: ${poll.question}`}
    >
      <p className={styles.pollQuestion}>{poll.question}</p>
      <div className={styles.pollOptions}>
        {poll.options.map((opt) => {
          const pct =
            totalVotes > 0 ? Math.round((opt.votes / totalVotes) * 100) : 0;
          return (
            <button
              key={opt.index}
              type="button"
              disabled={poll.isClosed || voteMutation.isPending}
              onClick={() => voteMutation.mutate(opt.index)}
              className={`${styles.pollOptionBtn} ${
                opt.meVoted ? styles.pollOptionBtnVoted : ''
              }`}
              aria-pressed={opt.meVoted}
            >
              <span
                className={styles.pollBarFill}
                style={{ width: `${pct}%` }}
                aria-hidden="true"
              />
              <div className={styles.pollOptionContent}>
                <span>
                  {opt.meVoted ? '✓ ' : ''}
                  {opt.label}
                </span>
                <span>
                  {opt.votes} {opt.votes === 1 ? 'vote' : 'votes'} ({pct}%)
                </span>
              </div>
              {opt.voters.length > 0 && (
                <div className={styles.pollVoters}>
                  {opt.voters.join(', ')}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 11.5,
          color: '#686868',
          fontFamily: 'var(--m-font-mono)',
        }}
      >
        {totalVotes} total {totalVotes === 1 ? 'vote' : 'votes'}
        {poll.isClosed ? ' · Poll closed' : ' · Click an option to vote'}
      </div>
    </div>
  );
}

interface MessageCardProps {
  message: RichMessage;
  myPeerId: string;
  knownAliases: string[];
  highlighted?: boolean;
  compact?: boolean;
}

export function MessageCard({
  message,
  myPeerId,
  knownAliases,
  highlighted = false,
  compact = false,
}: MessageCardProps) {
  const queryClient = useQueryClient();
  const setActivePodId = useSetAtom(activePodIdAtom);
  const [dmPeerMap, setDmPeerMap] = useAtom(activeDmPeerByPodAtom);
  const setUnreadMap = useSetAtom(unreadByConvoAtom);
  const setHighlightedId = useSetAtom(highlightedMessageIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);

  const otherPeerId = resolveMessagePeerId(
    message.senderPeerId,
    message.recipientPeerId,
    myPeerId
  );
  const isDmMessage = Boolean(message.recipientPeerId);
  const convoKey = conversationKey(message.podId, otherPeerId);
  const setQuoteTarget = useSetAtom(quoteTargetByConvoAtom(convoKey));

  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(message.body);
  const [moreEmojiOpen, setMoreEmojiOpen] = useState(false);

  const isOwn = Boolean(myPeerId && message.senderPeerId === myPeerId);
  const canMessageSenderPrivately =
    !isOwn &&
    !isDmMessage &&
    Boolean(message.senderPeerId) &&
    message.msgType !== 'SYSTEM';

  const openPrivateChatWithSender = () => {
    if (!message.senderPeerId || isOwn) return;
    setActivePodId(message.podId);
    setDmPeerMap({
      ...dmPeerMap,
      [message.podId]: message.senderPeerId,
    });
    const targetKey = conversationKey(message.podId, message.senderPeerId);
    setUnreadMap((prev) => {
      if (!(targetKey in prev)) return prev;
      const copy = { ...prev };
      delete copy[targetKey];
      return copy;
    });
    if (typeof window !== 'undefined' && window.innerWidth <= 900) {
      setRightPanel(null);
    }
  };

  const reactionMutation = useMutation({
    mutationFn: (emoji: string) =>
      apiFetch<{ message: RichMessage }>(
        `/api/messages/${message.id}/reactions`,
        {
          method: 'POST',
          body: JSON.stringify({ emoji }),
        }
      ),
    onSuccess: (res) => {
      if (res?.message) {
        patchMessageAcrossCaches(
          queryClient,
          message.podId,
          res.message,
          true,
          myPeerId
        );
      }
    },
  });

  const submitPinProposal = async () => {
    const res = await apiFetch<{
      proposal: PodProposalDto;
      pod?: PodDetail | null;
    }>(`/api/pods/${message.podId}/proposals`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'PIN_MESSAGE',
        messageId: message.id,
        reason: message.isPinned ? 'Unpin message' : 'Pin message in pod',
      }),
    });
    syncProposalIntoCaches(queryClient, message.podId, res.proposal, res.pod);
    queryClient.invalidateQueries({
      queryKey: ['messages', message.podId, 'group'],
    });
    queryClient.invalidateQueries({ queryKey: ['pins', message.podId] });
    setRightPanel('votes');
  };

  const pinMutation = useMutation({
    mutationFn: async () => {
      // Never create a pod-wide democratic proposal for a private 1:1 DM!
      if (!isDmMessage) {
        const pod = queryClient
          .getQueryData<{ pods: PodDetail[] }>(['pods'])
          ?.pods.find((p) => p.podId === message.podId);
        if (pod && pod.governanceMode !== 'ADMIN' && pod.memberCount > 1) {
          await submitPinProposal();
          return null;
        }
      }
      try {
        return await apiFetch<{ message: RichMessage }>(
          `/api/messages/${message.id}/pin`,
          { method: 'POST' }
        );
      } catch (err) {
        if (
          !isDmMessage &&
          err instanceof ApiError &&
          (err.status === 403 || err.status === 409)
        ) {
          await submitPinProposal();
          return null;
        }
        throw err;
      }
    },
    onSuccess: (res) => {
      if (res?.message) {
        patchMessageAcrossCaches(
          queryClient,
          message.podId,
          res.message,
          true,
          myPeerId
        );
      }
    },
  });

  const bookmarkMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ bookmarked: boolean; message: RichMessage }>(
        `/api/messages/${message.id}/bookmark`,
        { method: 'POST' }
      ),
    onSuccess: (res) => {
      if (res?.message) {
        patchMessageAcrossCaches(
          queryClient,
          message.podId,
          res.message,
          false,
          myPeerId
        );
      }
    },
  });

  const editMutation = useMutation({
    mutationFn: (body: string) =>
      apiFetch<{ message: RichMessage }>(`/api/messages/${message.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      }),
    onSuccess: (res) => {
      setEditing(false);
      if (res?.message) {
        patchMessageAcrossCaches(
          queryClient,
          message.podId,
          res.message,
          true,
          myPeerId
        );
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean }>(`/api/messages/${message.id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      markMessageDeletedInCaches(
        queryClient,
        message.podId,
        message.id,
        message.senderPeerId,
        message.recipientPeerId,
        myPeerId
      );
    },
  });

  // Centered compact pill for SYSTEM messages in main chat stream
  if (message.msgType === 'SYSTEM' && !compact) {
    return (
      <div
        className={`${styles.msgSystemRow} ${
          highlighted ? styles.msgRowHighlighted : ''
        }`}
        aria-label={`System notice: ${message.body}`}
      >
        <div className={styles.msgSystemPill}>
          <span>{message.body}</span>
          <time className={styles.msgSystemTime} dateTime={message.createdAt}>
            {formatClock(message.createdAt)}
          </time>
        </div>
      </div>
    );
  }

  const voiceAttachments = message.attachments.filter(
    (a) => a.kind === 'voice_note' || a.mimeType.startsWith('audio/')
  );
  const imageAttachments = message.attachments.filter(
    (a) =>
      a.kind !== 'voice_note' &&
      (a.kind === 'image' || a.mimeType.startsWith('image/'))
  );
  const fileAttachments = message.attachments.filter(
    (a) =>
      a.kind !== 'voice_note' &&
      !a.mimeType.startsWith('audio/') &&
      a.kind !== 'image' &&
      !a.mimeType.startsWith('image/')
  );

  const alignOwnRight = isOwn && !compact && message.msgType !== 'GOVERNANCE';

  return (
    <article
      className={`${styles.msgRow} ${alignOwnRight ? styles.msgRowOwn : ''} ${
        compact ? styles.msgRowCompact : ''
      } ${highlighted ? styles.msgRowHighlighted : ''}`}
      aria-label={`Message from ${message.senderAlias}`}
    >
      {!alignOwnRight &&
        (canMessageSenderPrivately && !compact ? (
          <button
            type="button"
            className={styles.msgAvatarBtn}
            onClick={openPrivateChatWithSender}
            title={`Message ${message.senderAlias} privately`}
            aria-label={`Message ${message.senderAlias} privately`}
          >
            <span
              className={styles.msgAvatar}
              style={{
                background: safeAvatarColor(
                  message.senderColor,
                  message.senderAlias
                ),
              }}
            >
              {aliasInitials(message.senderAlias)}
            </span>
          </button>
        ) : (
          <div
            className={styles.msgAvatar}
            style={{
              background: safeAvatarColor(
                message.senderColor,
                message.senderAlias
              ),
            }}
          >
            {aliasInitials(message.senderAlias)}
          </div>
        ))}

      <div
        className={`${styles.msgBubble} ${
          compact
            ? styles.msgBubbleCompact
            : alignOwnRight
              ? styles.msgBubbleOwn
              : styles.msgBubblePeer
        } ${message.isPinned ? styles.msgBubblePinned : ''}`}
      >
        {message.quoteMessage && (
          <div
            className={styles.quotePreview}
            onClick={() => setHighlightedId(message.quoteMessage!.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setHighlightedId(message.quoteMessage!.id);
            }}
          >
            <CornerUpLeft size={13} />
            <strong>{message.quoteMessage.senderAlias}:</strong>
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {message.quoteMessage.isDeleted
                ? 'Message deleted'
                : message.quoteMessage.body || 'Attachment'}
            </span>
          </div>
        )}

        <div className={styles.msgMeta}>
          {canMessageSenderPrivately && !compact ? (
            <button
              type="button"
              className={styles.msgAuthorBtn}
              onClick={openPrivateChatWithSender}
              title={`Message ${message.senderAlias} privately`}
            >
              {message.senderAlias}
            </button>
          ) : (
            <span className={styles.msgAuthor}>
              {isOwn && !compact ? 'You' : message.senderAlias}
            </span>
          )}

          {isOwn && compact && <span className={styles.msgSelfBadge}>you</span>}

          <time className={styles.msgTime} dateTime={message.createdAt}>
            {formatClock(message.createdAt)}
          </time>

          {message.editedAt && !message.isDeleted && (
            <span className={styles.msgTime}>(edited)</span>
          )}

          {message.isPinned && (
            <span
              className={styles.msgSelfBadge}
              style={{ background: '#e2fbed', color: '#164e2a' }}
            >
              pinned
            </span>
          )}

          {canMessageSenderPrivately && !compact && (
            <button
              type="button"
              className={styles.quickDmChip}
              onClick={openPrivateChatWithSender}
              title={`Start a private 1:1 chat with ${message.senderAlias}`}
              aria-label={`Message ${message.senderAlias} privately`}
            >
              <MessageCircle size={11} />
              <span>Message privately</span>
            </button>
          )}
        </div>

        {message.isDeleted ? (
          <div className={styles.msgDeleted}>This message was deleted.</div>
        ) : editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (editDraft.trim()) editMutation.mutate(editDraft.trim());
            }}
            style={{ marginTop: 6 }}
          >
            <textarea
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              rows={2}
              style={{
                width: '100%',
                minWidth: 220,
                padding: 8,
                borderRadius: 8,
                border: '1px solid #1f6b3a',
                fontFamily: 'var(--m-font-sans)',
                fontSize: 14,
              }}
              aria-label="Edit message body"
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button type="submit" className={styles.statusSaveBtn}>
                Save
              </button>
              <button
                type="button"
                className={styles.statusSaveBtn}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : message.msgType === 'GOVERNANCE' && message.proposal ? (
          <PodProposalVoteCard
            proposal={message.proposal}
            podId={message.podId}
            compact={compact}
          />
        ) : message.msgType === 'ICEBREAKER' ? (
          <div className={styles.icebreakerCard}>
            <div className={styles.icebreakerTag}>
              <Sparkles
                size={12}
                style={{ verticalAlign: 'middle', marginRight: 4 }}
              />
              Pod Icebreaker
            </div>
            <div className={styles.msgBody}>
              <RichMarkdown body={message.body} knownAliases={knownAliases} />
            </div>
          </div>
        ) : (
          <>
            {message.body && message.msgType !== 'POLL' && (
              <div className={styles.msgBody}>
                <RichMarkdown body={message.body} knownAliases={knownAliases} />
              </div>
            )}

            {message.poll && (
              <InteractivePoll poll={message.poll} podId={message.podId} />
            )}

            {voiceAttachments.map((att) => (
              <VoiceNotePlayer key={att.id} attachment={att} />
            ))}

            {(imageAttachments.length > 0 || fileAttachments.length > 0) && (
              <div className={styles.attachmentsGrid}>
                {imageAttachments.map((img) => (
                  <a
                    key={img.id}
                    href={buildAttachmentUrl(img.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <img
                      src={buildAttachmentUrl(img.url)}
                      alt={img.fileName}
                      loading="lazy"
                      className={styles.imageAttachment}
                    />
                  </a>
                ))}
                {fileAttachments.map((f) => (
                  <a
                    key={f.id}
                    href={buildAttachmentUrl(f.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.fileChip}
                  >
                    <Download size={15} />
                    <span>{f.fileName}</span>
                    <span className={styles.msgTime}>
                      ({formatBytes(f.sizeBytes)})
                    </span>
                  </a>
                ))}
              </div>
            )}
          </>
        )}

        {!message.isDeleted && message.reactions.length > 0 && (
          <div className={styles.reactionsRow}>
            {message.reactions.map((rx) => (
              <button
                key={rx.emoji}
                type="button"
                onClick={() => reactionMutation.mutate(rx.emoji)}
                className={`${styles.reactionPill} ${
                  rx.meReacted ? styles.reactionPillActive : ''
                }`}
                title={rx.aliases.join(', ')}
                aria-label={`React with ${rx.emoji}, ${rx.count} reactions`}
              >
                <span>{rx.emoji}</span>
                <span>{rx.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!message.isDeleted && (
        <div
          className={`${styles.hoverToolbar} ${
            alignOwnRight ? styles.hoverToolbarOwn : ''
          }`}
          role="toolbar"
          aria-label="Message actions"
        >
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={styles.toolbarBtn}
              onClick={() => reactionMutation.mutate(emoji)}
              aria-label={`React ${emoji}`}
              title={`React ${emoji}`}
            >
              {emoji}
            </button>
          ))}

          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={() => setMoreEmojiOpen((v) => !v)}
            aria-label="More reactions"
            title="More reactions"
          >
            <SmilePlus size={15} />
          </button>

          {moreEmojiOpen &&
            EXTRA_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className={styles.toolbarBtn}
                onClick={() => {
                  reactionMutation.mutate(emoji);
                  setMoreEmojiOpen(false);
                }}
                aria-label={`React ${emoji}`}
              >
                {emoji}
              </button>
            ))}

          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={() => setQuoteTarget(message)}
            aria-label="Quote Reply"
            title="Reply with quote"
          >
            <CornerUpLeft size={15} />
          </button>

          {canMessageSenderPrivately && (
            <button
              type="button"
              className={styles.toolbarBtn}
              onClick={openPrivateChatWithSender}
              aria-label={`Message ${message.senderAlias} privately`}
              title={`Message ${message.senderAlias} privately`}
            >
              <MessageCircle size={15} />
            </button>
          )}

          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={() => pinMutation.mutate()}
            aria-label={message.isPinned ? 'Unpin message' : 'Pin message'}
            title={
              message.isPinned
                ? 'Unpin'
                : isDmMessage
                  ? 'Pin in chat'
                  : 'Pin / Propose Pin Vote'
            }
          >
            <Pin size={15} />
          </button>

          <button
            type="button"
            className={styles.toolbarBtn}
            onClick={() => bookmarkMutation.mutate()}
            aria-label={
              message.isBookmarked ? 'Remove bookmark' : 'Bookmark message'
            }
            title={message.isBookmarked ? 'Remove Bookmark' : 'Save message'}
          >
            <Bookmark size={15} />
          </button>

          {isOwn && message.msgType !== 'GOVERNANCE' && (
            <>
              <button
                type="button"
                className={styles.toolbarBtn}
                onClick={() => {
                  setEditDraft(message.body);
                  setEditing(true);
                }}
                aria-label="Edit message"
                title="Edit"
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                className={styles.toolbarBtn}
                onClick={() => deleteMutation.mutate()}
                aria-label="Delete message"
                title="Delete"
              >
                <Trash2 size={15} color="#b42318" />
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

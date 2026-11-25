'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  Bookmark,
  Ellipsis,
  MessageCircle,
  Pencil,
  Pin,
  Reply,
  Trash2,
} from 'lucide-react';
import { ApiError, apiFetch, buildAttachmentUrl } from '@/lib/api';
import { colorVar } from '@/lib/pieces';
import {
  highlightedMessageIdAtom,
  peerReadByConvoAtom,
  quoteTargetByConvoAtom,
  rightPanelAtom,
} from '@/state/workspaceAtoms';
import {
  markMessageDeletedInCaches,
  patchMessageAcrossCaches,
  syncProposalIntoCaches,
} from '@/state/wsPodClient';
import { serverWords } from '@/lib/stream';
import { useOpenConversation } from '@/state/roomActions';
import { RichMarkdown } from '@/components/workspace/markdown';
import { PollBlock, VoiceNote, VoteBody, clockTime } from '@/components/workspace/blocks';
import {
  conversationKey,
  resolveMessagePeerId,
  type DmConversationSummary,
  type PodDetail,
  type PodProposalDto,
  type RichMessage,
} from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import c from '@/app/app/chat.module.css';

const QUICK = ['👍', '🔥', '😂', '🎯', '❤️'];
const MORE = ['🎉', '👀', '🙌', '⚡', '🤝', '✅'];

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageCard({
  message,
  myPeerId,
  knownAliases,
  highlighted = false,
  compact = false,
  follows = false,
}: {
  message: RichMessage;
  myPeerId: string;
  knownAliases: string[];
  highlighted?: boolean;
  // In a side panel: no actions, always on the left.
  compact?: boolean;
  // Same person, moments after the last block: no name again.
  follows?: boolean;
}) {
  const queryClient = useQueryClient();
  const openConversation = useOpenConversation();
  const setHighlighted = useSetAtom(highlightedMessageIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);
  const peerRead = useAtomValue(peerReadByConvoAtom);

  const otherPeerId = resolveMessagePeerId(
    message.senderPeerId,
    message.recipientPeerId,
    myPeerId
  );
  const isPrivate = Boolean(message.recipientPeerId);
  const convoKey = conversationKey(message.podId, otherPeerId);
  const setQuote = useSetAtom(quoteTargetByConvoAtom(convoKey));

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [fresh] = useState(() => Date.now() - Date.parse(message.createdAt) < 4000);

  const own = Boolean(myPeerId && message.senderPeerId === myPeerId);
  const canWriteBack =
    !own && !isPrivate && Boolean(message.senderPeerId) && message.msgType !== 'SYSTEM';

  const patch = (res: { message: RichMessage } | null, shared = true) => {
    if (res?.message) {
      patchMessageAcrossCaches(queryClient, message.podId, res.message, shared, myPeerId);
    }
  };

  const react = useMutation({
    mutationFn: (emoji: string) =>
      apiFetch<{ message: RichMessage }>(`/api/messages/${message.id}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      }),
    onSuccess: (res) => patch(res),
  });

  const proposePin = async () => {
    const res = await apiFetch<{ proposal: PodProposalDto; pod?: PodDetail | null }>(
      `/api/pods/${message.podId}/proposals`,
      {
        method: 'POST',
        body: JSON.stringify({ kind: 'PIN_MESSAGE', messageId: message.id }),
      }
    );
    syncProposalIntoCaches(queryClient, message.podId, res.proposal, res.pod);
    queryClient.invalidateQueries({ queryKey: ['messages', message.podId, 'group'] });
    queryClient.invalidateQueries({ queryKey: ['pins', message.podId] });
    setRightPanel('votes');
  };

  const pin = useMutation({
    mutationFn: async () => {
      // A private message never turns into a vote the whole room can see.
      if (!isPrivate) {
        const pod = queryClient
          .getQueryData<{ pods: PodDetail[] }>(['pods'])
          ?.pods.find((p) => p.podId === message.podId);
        if (pod && pod.governanceMode !== 'ADMIN' && pod.memberCount > 1) {
          await proposePin();
          return null;
        }
      }
      try {
        return await apiFetch<{ message: RichMessage }>(`/api/messages/${message.id}/pin`, {
          method: 'POST',
        });
      } catch (err) {
        if (!isPrivate && err instanceof ApiError && (err.status === 403 || err.status === 409)) {
          await proposePin();
          return null;
        }
        throw err;
      }
    },
    onSuccess: (res) => patch(res),
  });

  const save = useMutation({
    mutationFn: () =>
      apiFetch<{ bookmarked: boolean; message: RichMessage }>(
        `/api/messages/${message.id}/bookmark`,
        { method: 'POST' }
      ),
    onSuccess: (res) => patch(res, false),
  });

  const edit = useMutation({
    mutationFn: (body: string) =>
      apiFetch<{ message: RichMessage }>(`/api/messages/${message.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      }),
    onSuccess: (res) => {
      setEditing(false);
      patch(res);
    },
  });

  const remove = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean }>(`/api/messages/${message.id}`, { method: 'DELETE' }),
    onSuccess: () =>
      markMessageDeletedInCaches(
        queryClient,
        message.podId,
        message.id,
        message.senderPeerId,
        message.recipientPeerId,
        myPeerId
      ),
  });

  if (message.msgType === 'SYSTEM') {
    return (
      <div className={`${c.system} ${highlighted ? c.lit : ''}`}>
        <RichMarkdown body={serverWords(message.body)} knownAliases={knownAliases} />
      </div>
    );
  }

  const voice = message.attachments.filter(
    (a) => a.kind === 'voice_note' || a.mimeType.startsWith('audio/')
  );
  const images = message.attachments.filter(
    (a) => !voice.includes(a) && (a.kind === 'image' || a.mimeType.startsWith('image/'))
  );
  const files = message.attachments.filter((a) => !voice.includes(a) && !images.includes(a));

  const seen =
    own &&
    isPrivate &&
    Boolean(otherPeerId) &&
    message.id <=
      Math.max(
        peerRead[convoKey] ?? 0,
        queryClient
          .getQueryData<{ conversations: DmConversationSummary[] }>(['dms', message.podId])
          ?.conversations.find((d) => d.peerId === otherPeerId)?.peerLastReadMessageId ?? 0
      );

  const mineOnRight = own && !compact && message.msgType !== 'GOVERNANCE';
  const icebreaker = message.msgType === 'ICEBREAKER' && !message.isDeleted;
  const vote = message.msgType === 'GOVERNANCE' && message.proposal && !message.isDeleted;
  const wide = Boolean(vote || message.poll);

  const shape = [
    c.bub,
    compact && c.full,
    mineOnRight && c.me,
    mineOnRight && isPrivate && c.mePrivate,
    wide && c.wide,
    icebreaker && c.ice,
    vote && message.proposal?.status !== 'OPEN' && c.settled,
    voice.length > 0 && !message.body && c.round,
    highlighted && c.lit,
    fresh && !compact && c.fresh,
  ]
    .filter(Boolean)
    .join(' ');

  const submitEdit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim()) edit.mutate(draft.trim());
  };

  const tools = !compact && !message.isDeleted && (
    <div className={c.tools} role="toolbar" aria-label={`Actions for the message from ${message.senderAlias}`}>
      {(more ? MORE : QUICK).map((emoji) => (
        <button
          key={emoji}
          type="button"
          aria-label={`React with ${emoji}`}
          onClick={() => {
            react.mutate(emoji);
            setMore(false);
            setToolsOpen(false);
          }}
        >
          {emoji}
        </button>
      ))}
      <button type="button" aria-pressed={more} aria-label="More reactions" title="More reactions" onClick={() => setMore((v) => !v)}>
        <Ellipsis size={18} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Quote it"
        title="Quote"
        onClick={() => {
          setQuote(message);
          setToolsOpen(false);
        }}
      >
        <Reply size={18} aria-hidden="true" />
      </button>
      {canWriteBack && (
        <button
          type="button"
          aria-label={`Write to ${message.senderAlias} privately`}
          title="Write privately"
          onClick={() => openConversation(message.podId, message.senderPeerId)}
        >
          <MessageCircle size={18} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        aria-pressed={message.isPinned}
        aria-label={message.isPinned ? 'Unpin it' : 'Pin it'}
        title={message.isPinned ? 'Unpin' : 'Pin'}
        onClick={() => pin.mutate()}
      >
        <Pin size={18} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-pressed={message.isBookmarked}
        aria-label={message.isBookmarked ? 'Take it off your saved list' : 'Save it'}
        title={message.isBookmarked ? 'Unsave' : 'Save'}
        onClick={() => save.mutate()}
      >
        <Bookmark size={18} aria-hidden="true" />
      </button>
      {own && message.msgType !== 'GOVERNANCE' && (
        <>
          <button
            type="button"
            aria-label="Edit it"
            title="Edit"
            onClick={() => {
              setDraft(message.body);
              setEditing(true);
              setToolsOpen(false);
            }}
          >
            <Pencil size={18} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Delete it" title="Delete" onClick={() => remove.mutate()}>
            <Trash2 size={18} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );

  const name = own ? 'You' : message.senderAlias;
  const meta = [
    message.editedAt && !message.isDeleted && 'edited',
    message.isPinned && 'pinned',
    message.isBookmarked && 'saved',
    vote && 'room vote',
    message.poll && 'poll',
  ].filter(Boolean);
  const error = react.error ?? pin.error ?? save.error ?? edit.error ?? remove.error;

  return (
    <div className={`${c.row} ${mineOnRight ? c.rowMe : ''} ${follows ? c.follows : ''}`} data-open={toolsOpen ? '' : undefined}>
      <article className={shape} style={icebreaker ? undefined : colorVar(message.senderAlias)} aria-label={`From ${message.senderAlias}`}>
        {icebreaker ? (
          <h3 className={c.by}>
            Icebreaker, dealt by {own ? 'you' : message.senderAlias}
            <time dateTime={message.createdAt}>{clockTime(message.createdAt)}</time>
          </h3>
        ) : (
          !isPrivate &&
          !follows && (
            <h3 className={c.by}>
              {canWriteBack && !compact ? (
                <button
                  type="button"
                  title={`Write to ${message.senderAlias} privately`}
                  onClick={() => openConversation(message.podId, message.senderPeerId)}
                >
                  {name}
                </button>
              ) : (
                <span>{name}</span>
              )}
              <time dateTime={message.createdAt}>
                {[clockTime(message.createdAt), ...meta].join(', ')}
              </time>
            </h3>
          )
        )}

        {message.quoteMessage && !message.isDeleted && (
          <button
            type="button"
            className={c.quote}
            style={colorVar(message.quoteMessage.senderAlias)}
            onClick={() => setHighlighted(message.quoteMessage!.id)}
          >
            <b>{message.quoteMessage.senderAlias}</b>{' '}
            {message.quoteMessage.isDeleted
              ? 'deleted this'
              : message.quoteMessage.body || 'sent a file'}
          </button>
        )}

        {message.isDeleted ? (
          <p className={c.gone}>Deleted</p>
        ) : editing ? (
          <form className={c.edit} onSubmit={submitEdit}>
            <textarea
              rows={2}
              value={draft}
              aria-label="Edit the message"
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className={ui.row}>
              <button type="submit" className={`${ui.btn} ${ui.small} ${ui.ink}`} disabled={edit.isPending}>
                Save
              </button>
              <button type="button" className={`${ui.btn} ${ui.small} ${ui.glass}`} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : vote ? (
          <VoteBody proposal={message.proposal!} podId={message.podId} />
        ) : (
          <>
            {message.body && message.msgType !== 'POLL' && (
              <div className={icebreaker ? c.iceQ : c.text}>
                <RichMarkdown body={message.body} knownAliases={knownAliases} />
              </div>
            )}
            {message.poll && (
              <PollBlock
                poll={message.poll}
                podId={message.podId}
                canClose={(() => {
                  if (own) return true;
                  const pod = queryClient
                    .getQueryData<{ pods: PodDetail[] }>(['pods'])
                    ?.pods.find((p) => p.podId === message.podId);
                  return Boolean(pod && pod.governanceMode === 'ADMIN' && pod.myRole !== 'MEMBER');
                })()}
              />
            )}
            {voice.map((a) => (
              <VoiceNote key={a.id} attachment={a} />
            ))}
            {images.map((a) => (
              <a key={a.id} className={c.image} href={buildAttachmentUrl(a.url)} target="_blank" rel="noopener noreferrer">
                <img src={buildAttachmentUrl(a.url)} alt={a.fileName} loading="lazy" />
              </a>
            ))}
            {files.map((a) => (
              <a key={a.id} className={c.file} href={buildAttachmentUrl(a.url)} target="_blank" rel="noopener noreferrer">
                <b>{a.fileName}</b>
                <span>{fileSize(a.sizeBytes)}</span>
              </a>
            ))}
          </>
        )}

        {!message.isDeleted && message.reactions.length > 0 && (
          <div className={c.reactions}>
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={c.re}
                title={r.aliases.join(', ')}
                aria-pressed={r.meReacted}
                aria-label={`${r.emoji}, ${r.count}. ${r.aliases.join(', ')}`}
                onClick={() => react.mutate(r.emoji)}
              >
                {r.emoji} {r.count}
              </button>
            ))}
          </div>
        )}

        {isPrivate && (
          <small className={c.sent}>
            {[clockTime(message.createdAt), ...meta].join(', ')}{' '}
            {own && !message.isDeleted && <b>{seen ? '✓✓ Seen' : '✓ Sent'}</b>}
          </small>
        )}
        {error && (
          <p className={c.oops} role="alert">
            {error.message}
          </p>
        )}
      </article>

      {tools && (
        <button
          type="button"
          className={c.dots}
          aria-expanded={toolsOpen}
          aria-label={`Actions for the message from ${message.senderAlias}`}
          onClick={(e) => {
            const row = e.currentTarget.parentElement;
            setToolsOpen((v) => !v);
            requestAnimationFrame(() =>
              row?.querySelector('[role="toolbar"]')?.scrollIntoView({ block: 'nearest' })
            );
          }}
        >
          <Ellipsis size={20} aria-hidden="true" />
        </button>
      )}
      {tools}
    </div>
  );
}

'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, buildAttachmentUrl } from '@/lib/api';
import { colorVar } from '@/lib/pieces';
import { serverWords } from '@/lib/stream';
import { patchMessageAcrossCaches, syncProposalIntoCaches } from '@/state/wsPodClient';
import type {
  AttachmentItem,
  PodDetail,
  PodProposalDto,
  PollData,
  RichMessage,
} from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import c from '@/app/app/chat.module.css';

export function clockTime(iso: string | null | undefined): string {
  const d = new Date(iso ?? '');
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function seconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const whole = Math.round(sec);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function pct(part: number, whole: number): CSSProperties {
  return { '--pct': `${whole > 0 ? Math.round((100 * part) / whole) : 0}%` } as CSSProperties;
}

function timeLeft(proposal: PodProposalDto, now: number): string {
  const left = Math.round((Date.parse(proposal.expiresAt) - now) / 1000);
  if (Number.isNaN(left)) return '';
  if (left <= 0) return 'time is up';
  if (left < 60) return `${left} s left`;
  return `${Math.ceil(left / 60)} min left`;
}

export function VoteBody({
  proposal,
  podId,
}: {
  proposal: PodProposalDto;
  podId: string;
}) {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const open = proposal.status === 'OPEN';

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [open]);

  const act = useMutation({
    mutationFn: (vote: boolean | null) =>
      apiFetch<{ proposal: PodProposalDto; pod?: PodDetail | null }>(
        `/api/proposals/${proposal.id}/${vote === null ? 'resolve' : 'vote'}`,
        {
          method: 'POST',
          body: vote === null ? undefined : JSON.stringify({ vote }),
        }
      ),
    onSuccess: (res) => {
      syncProposalIntoCaches(queryClient, podId, res.proposal, res.pod);
      queryClient.invalidateQueries({ queryKey: ['pods'] });
    },
  });

  const yes = proposal.yesCount ?? 0;
  const no = proposal.noCount ?? 0;
  const cast = yes + no;
  const toVote = Math.max(0, proposal.eligibleCount - cast);
  const timeUp = open && Date.parse(proposal.expiresAt) <= now;
  const names = [
    proposal.yesAliases?.length ? `Yes: ${proposal.yesAliases.join(', ')}` : '',
    proposal.noAliases?.length ? `No: ${proposal.noAliases.join(', ')}` : '',
  ].filter(Boolean);

  return (
    <div className={c.poll} role="group" aria-label={`Vote: ${serverWords(proposal.title)}`}>
      <p className={c.pollQ}>{serverWords(proposal.title)}</p>
      {proposal.reason && <p>{proposal.reason}</p>}
      {[true, false].map((side) => {
        const count = side ? yes : no;
        const mine = proposal.myVote === side;
        return (
          <button
            key={String(side)}
            type="button"
            className={c.opt}
            style={pct(count, cast)}
            aria-pressed={mine}
            disabled={!open || act.isPending}
            onClick={() => act.mutate(side)}
          >
            <span>
              {side ? 'Yes' : 'No'}
              {mine && ', your vote'}
            </span>
            <span>{count}</span>
          </button>
        );
      })}
      {act.error && (
        <p className={ui.alert} style={{ background: 'var(--glass)' }} role="alert">
          {act.error.message}
        </p>
      )}
      {timeUp && (
        <button
          type="button"
          className={`${ui.btn} ${ui.ink}`}
          disabled={act.isPending}
          onClick={() => act.mutate(null)}
        >
          Count it
        </button>
      )}
      <p className={c.pollF}>
        {open
          ? `More Yes than No wins. ${toVote} to vote, ${timeLeft(proposal, now)}.`
          : proposal.status === 'PASSED'
            ? `Passed ${clockTime(proposal.resolvedAt)}`.trim()
            : `Did not pass ${clockTime(proposal.resolvedAt)}`.trim()}
      </p>
      {names.length > 0 && (
        <details className={c.names}>
          <summary>Who voted</summary>
          {names.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </details>
      )}
    </div>
  );
}

export function VoteBlock({
  proposal,
  podId,
}: {
  proposal: PodProposalDto;
  podId: string;
}) {
  return (
    <article
      className={`${c.bub} ${c.full} ${proposal.status === 'OPEN' ? '' : c.settled}`}
      style={colorVar(proposal.proposerAlias)}
    >
      <h3 className={c.by}>
        {proposal.proposerAlias}
        <time>{clockTime(proposal.createdAt)}</time>
      </h3>
      <VoteBody proposal={proposal} podId={podId} />
    </article>
  );
}

export function PollBlock({ poll, podId }: { poll: PollData; podId: string }) {
  const queryClient = useQueryClient();
  const total = poll.options.reduce((n, o) => n + o.votes, 0);
  const vote = useMutation({
    mutationFn: (optionIndex: number) =>
      apiFetch<{ message: RichMessage }>(`/api/polls/${poll.pollId}/vote`, {
        method: 'POST',
        body: JSON.stringify({ optionIndex }),
      }),
    onSuccess: (res) => {
      if (res?.message) patchMessageAcrossCaches(queryClient, podId, res.message, true);
    },
  });

  return (
    <div className={c.poll} role="group" aria-label={`Poll: ${poll.question}`}>
      <p className={c.pollQ}>{poll.question}</p>
      {poll.options.map((o) => (
        <button
          key={o.index}
          type="button"
          className={c.opt}
          style={pct(o.votes, total)}
          aria-pressed={o.meVoted}
          disabled={poll.isClosed || vote.isPending}
          title={o.voters.join(', ') || undefined}
          onClick={() => vote.mutate(o.index)}
        >
          <span>{o.label}</span>
          <span>{o.votes}</span>
        </button>
      ))}
      <p className={c.pollF}>
        {total === 0 ? 'No votes yet' : `${total} ${total === 1 ? 'vote' : 'votes'}`}
        {poll.isClosed ? ', closed' : ''}
      </p>
    </div>
  );
}

export function VoiceNote({ attachment }: { attachment: AttachmentItem }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState(attachment.durationMs / 1000 || 0);

  // The server keeps no waveform, so the bars are drawn from the id and stay the same.
  const bars = useMemo(() => {
    let seed = (attachment.id || 7) * 2654435761;
    return Array.from({ length: 22 }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return 24 + (seed % 72);
    });
  }, [attachment.id]);

  const seek = (sec: number) => {
    const el = audio.current;
    if (!el || length <= 0) return;
    el.currentTime = Math.max(0, Math.min(length, sec));
    setAt(el.currentTime);
  };
  const onBars = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * length);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight') seek(at + 2);
    else if (e.key === 'ArrowLeft') seek(at - 2);
    else return;
    e.preventDefault();
  };
  const played = length > 0 ? at / length : 0;

  return (
    <div className={c.note}>
      <audio
        ref={audio}
        src={buildAttachmentUrl(attachment.url)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setAt(0);
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setLength(d);
        }}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
      />
      <button
        type="button"
        className={c.play}
        aria-label={`${playing ? 'Pause' : 'Play'} voice note, ${Math.round(length)} seconds`}
        onClick={() => (playing ? audio.current?.pause() : audio.current?.play().catch(() => {}))}
      >
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <path d={playing ? 'M2 1h4v12H2zM8 1h4v12H8z' : 'M3 1l9 6-9 6z'} />
        </svg>
      </button>
      <div
        className={c.bars}
        role="slider"
        tabIndex={0}
        aria-label="Place in the voice note"
        aria-valuemin={0}
        aria-valuemax={Math.round(length)}
        aria-valuenow={Math.round(at)}
        onClick={onBars}
        onKeyDown={onKey}
      >
        {bars.map((v, i) => (
          <i
            key={i}
            data-on={played > i / bars.length ? '' : undefined}
            style={{ '--v': `${v}%` } as CSSProperties}
          />
        ))}
      </div>
      <span>{seconds(playing || at > 0 ? at : length)}</span>
    </div>
  );
}

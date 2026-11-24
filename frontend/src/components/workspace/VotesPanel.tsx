'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtom, useSetAtom } from 'jotai';
import { apiFetch } from '@/lib/api';
import { adminSettingsPodIdAtom, proposeSheetOpenAtom } from '@/state/workspaceAtoms';
import { personalizeProposal, syncProposalIntoCaches } from '@/state/wsPodClient';
import { SizeChoice } from '@/components/workspace/SizeChoice';
import { VoteBlock } from '@/components/workspace/blocks';
import type {
  CreateProposalRequest,
  PodDetail,
  PodMember,
  PodProposalDto,
  ProposalKind,
} from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import s from '@/app/app/workspace.module.css';
import c from '@/app/app/chat.module.css';

const KINDS: Array<{ value: ProposalKind; label: string }> = [
  { value: 'RENAME_POD', label: 'Name the room' },
  { value: 'UPDATE_TOPIC', label: 'Say what the room is about' },
  { value: 'CHANGE_CAPACITY', label: 'Change its size' },
  { value: 'TOGGLE_LOCK', label: 'Close or open it to new people' },
  { value: 'KICK_MEMBER', label: 'Remove a member' },
  { value: 'PIN_MESSAGE', label: 'Pin or unpin a message' },
];

export function VotesPanel({
  pod,
  members,
}: {
  pod: PodDetail;
  members: PodMember[];
}) {
  const [proposing, setProposing] = useAtom(proposeSheetOpenAtom);
  const setSettingsPod = useSetAtom(adminSettingsPodIdAtom);
  const proRoom = pod.governanceMode === 'ADMIN';

  const votes = useQuery<{ proposals: PodProposalDto[] }>({
    queryKey: ['proposals', pod.podId],
    queryFn: async () => {
      const res = await apiFetch<{ proposals: PodProposalDto[] }>(
        `/api/pods/${pod.podId}/proposals`
      );
      return {
        proposals: (res.proposals || []).map((p) =>
          personalizeProposal(p, pod.myAlias)
        ),
      };
    },
  });

  const all = votes.data?.proposals ?? [];
  const open = all.filter((p) => p.status === 'OPEN');
  const closed = all.filter((p) => p.status !== 'OPEN');

  if (proRoom) {
    return (
      <>
        <p className={s.hint}>
          This group has an owner, so nothing here goes to a vote.
        </p>
        {pod.myRole !== 'MEMBER' && (
          <button
            type="button"
            className={`${ui.btn} ${ui.blue}`}
            onClick={() => setSettingsPod(pod.podId)}
          >
            Manage the group
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <p className={s.hint}>
        More Yes than No wins. A vote passes early once the seats left could not
        turn it.
      </p>
      {proposing ? (
        <ProposeForm pod={pod} members={members} onClose={() => setProposing(false)} />
      ) : (
        <button
          type="button"
          className={`${ui.btn} ${ui.big} ${ui.blue}`}
          onClick={() => setProposing(true)}
        >
          Start a vote
        </button>
      )}

      {votes.isLoading && <p className={s.hint}>Counting.</p>}
      {votes.isSuccess && all.length === 0 && (
        <p className={s.hint}>No votes yet in this room.</p>
      )}
      {open.map((p) => (
        <VoteBlock key={p.id} proposal={p} podId={pod.podId} />
      ))}
      {closed.length > 0 && <h3 className={s.lh} style={{ padding: '8px 0 0' }}>Settled</h3>}
      {closed.map((p) => (
        <VoteBlock key={p.id} proposal={p} podId={pod.podId} />
      ))}
    </>
  );
}

function ProposeForm({
  pod,
  members,
  onClose,
}: {
  pod: PodDetail;
  members: PodMember[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const others = members.filter((m) => m.peerId !== pod.myPeerId);
  const [kind, setKind] = useState<ProposalKind>('RENAME_POD');
  const [name, setName] = useState(pod.title);
  const [topic, setTopic] = useState(pod.description);
  const [size, setSize] = useState<10 | 25 | 50>(pod.maxMembers >= 50 ? 25 : 50);
  const [locked, setLocked] = useState(pod.allowRandomMatch);
  const [target, setTarget] = useState(others[0]?.peerId ?? '');
  const [messageId, setMessageId] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(5);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (others.length > 0 && !others.some((m) => m.peerId === target)) {
      setTarget(others[0].peerId);
    }
  }, [others, target]);

  const propose = useMutation({
    mutationFn: (payload: CreateProposalRequest) =>
      apiFetch<{ proposal: PodProposalDto; pod?: PodDetail | null }>(
        `/api/pods/${pod.podId}/proposals`,
        { method: 'POST', body: JSON.stringify(payload) }
      ),
    onSuccess: (res) => {
      syncProposalIntoCaches(queryClient, pod.podId, res.proposal, res.pod);
      queryClient.invalidateQueries({ queryKey: ['proposals', pod.podId] });
      queryClient.invalidateQueries({ queryKey: ['messages', pod.podId, 'group'] });
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const payload: CreateProposalRequest = {
      kind,
      reason: reason.trim() || undefined,
      expiresInMinutes: minutes,
    };
    if (kind === 'RENAME_POD') {
      if (!name.trim() && !topic.trim()) return setError('Give the room a name first.');
      payload.label = payload.title = name.trim();
      payload.topic = payload.description = topic.trim();
    } else if (kind === 'UPDATE_TOPIC') {
      if (!topic.trim()) return setError('Write what the room is about.');
      payload.topic = payload.description = topic.trim();
    } else if (kind === 'CHANGE_CAPACITY') {
      payload.maxMembers = size;
    } else if (kind === 'TOGGLE_LOCK') {
      payload.locked = locked;
    } else if (kind === 'KICK_MEMBER') {
      if (!target) return setError('There is nobody else here yet.');
      payload.targetPeerId = target;
    } else {
      const id = Number(messageId.trim());
      if (!Number.isInteger(id) || id <= 0) {
        return setError('Type the message number, or press the pin on the message itself.');
      }
      payload.messageId = id;
    }
    propose.mutate(payload);
  };

  const input = `${ui.input} ${ui.onColor}`;

  return (
    <form className={c.form} style={{ '--c': 'var(--c-cobalt)' } as React.CSSProperties} onSubmit={submit}>
      {error && (
        <p className={ui.alert} style={{ background: 'var(--glass)' }} role="alert">
          {error}
        </p>
      )}
      <label className={ui.field}>
        <span>Ask the room to</span>
        <select
          className={input}
          value={kind}
          onChange={(e) => setKind(e.target.value as ProposalKind)}
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>

      {kind === 'RENAME_POD' && (
        <label className={ui.field}>
          <span>New name</span>
          <input
            className={input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder={pod.interestLabel}
          />
        </label>
      )}
      {(kind === 'RENAME_POD' || kind === 'UPDATE_TOPIC') && (
        <label className={ui.field}>
          <span>{kind === 'RENAME_POD' ? 'What it is about (optional)' : 'What it is about'}</span>
          <input
            className={input}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            maxLength={200}
          />
        </label>
      )}
      {kind === 'CHANGE_CAPACITY' && (
        <SizeChoice value={size} onChange={(v) => v && setSize(v)} onColor />
      )}
      {kind === 'TOGGLE_LOCK' && (
        <div className={ui.choices} role="group" aria-label="New people">
          <button type="button" className={`${ui.choice} ${ui.onColor}`} aria-pressed={locked} onClick={() => setLocked(true)}>
            Close it
          </button>
          <button type="button" className={`${ui.choice} ${ui.onColor}`} aria-pressed={!locked} onClick={() => setLocked(false)}>
            Open it
          </button>
        </div>
      )}
      {kind === 'KICK_MEMBER' && (
        <label className={ui.field}>
          <span>Who</span>
          <select className={input} value={target} onChange={(e) => setTarget(e.target.value)}>
            {others.length === 0 && <option value="">Nobody else here yet</option>}
            {others.map((m) => (
              <option key={m.peerId} value={m.peerId}>
                {m.alias}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === 'PIN_MESSAGE' && (
        <label className={ui.field}>
          <span>Message number</span>
          <input
            className={input}
            inputMode="numeric"
            value={messageId}
            onChange={(e) => setMessageId(e.target.value)}
          />
        </label>
      )}

      <label className={ui.field}>
        <span>Why (optional)</span>
        <input
          className={input}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={160}
        />
      </label>

      <label className={ui.field}>
        <span>Open for</span>
        <select
          className={input}
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
        >
          <option value={5}>5 minutes</option>
          <option value={15}>15 minutes</option>
          <option value={60}>An hour</option>
        </select>
      </label>

      <div className={s.cardBtns}>
        <button type="button" className={`${ui.btn} ${ui.glass}`} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className={`${ui.btn} ${ui.ink}`} disabled={propose.isPending}>
          Start vote
        </button>
      </div>
    </form>
  );
}

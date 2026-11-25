'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAtomValue, useSetAtom } from 'jotai';
import { apiFetch } from '@/lib/api';
import { colorVar, initials, pieceShape } from '@/lib/pieces';
import {
  adminSettingsPodIdAtom,
  inviteModalPodIdAtom,
  rightPanelAtom,
} from '@/state/workspaceAtoms';
import { syncProposalIntoCaches } from '@/state/wsPodClient';
import { remoteSpeakingMapAtom, useVoiceActions } from '@/state/voiceEngine';
import {
  useLeaveRoom,
  useMergeRoster,
  useOpenConversation,
  useRoomCall,
} from '@/state/roomActions';
import { Piece } from '@/components/pieces/Piece';
import type { PodDetail, PodMember, PodProposalDto } from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import s from '@/app/app/workspace.module.css';

function where(m: PodMember, inCall: boolean): string {
  if (inCall) return 'In the call';
  return m.online ? 'Online' : 'Away';
}

export function PeoplePanel({
  pod,
  pods,
  members,
  activePeerId,
}: {
  pod: PodDetail;
  pods: PodDetail[];
  members: PodMember[];
  activePeerId: string | null;
}) {
  const [picked, setPicked] = useState<string | null>(activePeerId);
  const [asList, setAsList] = useState(false);
  const { peers } = useRoomCall(pod);
  const speakingMap = useAtomValue(remoteSpeakingMapAtom);
  const inCall = new Set(peers.map((p) => p.peerId));

  // Opening a private chat also picks that person up.
  useEffect(() => setPicked(activePeerId), [activePeerId]);

  const order = [...members].sort((a, b) => {
    const rank = (m: PodMember) =>
      inCall.has(m.peerId) || m.inVoice ? 0 : m.online ? 1 : 2;
    return rank(a) - rank(b) || a.alias.localeCompare(b.alias);
  });
  const person = members.find((m) => m.peerId === picked) ?? null;
  const free = Math.max(0, pod.maxMembers - members.length);
  const toggle = (m: PodMember) =>
    setPicked((cur) => (cur === m.peerId ? null : m.peerId));

  return (
    <>
      <div className={s.sideHead}>
        <h2>
          {members.length} of {pod.maxMembers} seats
        </h2>
        <button
          type="button"
          className={`${ui.btn} ${ui.small}`}
          aria-pressed={asList}
          onClick={() => setAsList((v) => !v)}
        >
          Names
        </button>
      </div>

      {asList ? (
        <div className={s.list}>
          {order.map((m) => (
            <button
              key={m.peerId}
              type="button"
              style={colorVar(m.alias)}
              aria-expanded={picked === m.peerId}
              onClick={() => toggle(m)}
            >
              <Piece alias={m.alias} away={!m.online} />
              <span>
                <b>
                  {m.alias}
                  {m.peerId === pod.myPeerId ? ' (you)' : ''}
                </b>
                <small>
                  {where(m, inCall.has(m.peerId) || m.inVoice)}
                  {m.customStatus ? `. ${m.customStatus}` : ''}
                </small>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className={s.tray}>
          {order.map((m) => {
            const self = m.peerId === pod.myPeerId;
            const talking = inCall.has(m.peerId) || m.inVoice;
            return (
              <button
                key={m.peerId}
                type="button"
                className={s.seat}
                style={{ ...colorVar(m.alias), borderRadius: pieceShape(m.alias) }}
                title={m.alias}
                data-away={m.online ? undefined : ''}
                data-you={self ? '' : undefined}
                data-speaking={speakingMap[m.peerId] ? '' : undefined}
                aria-expanded={picked === m.peerId}
                aria-label={`${self ? `You, ${m.alias}` : m.alias}. ${where(m, talking)}`}
                onClick={() => toggle(m)}
              >
                {self ? 'You' : initials(m.alias)}
                {talking && <em />}
              </button>
            );
          })}
          {/* Big rooms would be mostly outlines, so at most one row of free seats is drawn. */}
          {Array.from({ length: free > 10 ? 4 : free }, (_, i) => (
            <span key={`free-${i}`} className={s.free} aria-hidden="true" />
          ))}
          {free > 10 && <span className={s.free}>+{free - 4}</span>}
        </div>
      )}

      {person ? (
        <PersonCard
          key={person.peerId}
          pod={pod}
          person={person}
          chatting={person.peerId === activePeerId}
        />
      ) : (
        <p className={s.hint}>Press a piece to see who it is.</p>
      )}

      <AboutRoom pod={pod} pods={pods} />
    </>
  );
}

function PersonCard({
  pod,
  person,
  chatting,
}: {
  pod: PodDetail;
  person: PodMember;
  chatting: boolean;
}) {
  const queryClient = useQueryClient();
  const mergeRoster = useMergeRoster();
  const openConversation = useOpenConversation();
  const setRightPanel = useSetAtom(rightPanelAtom);
  const { dmSession, startDmCall } = useVoiceActions();
  const { peers } = useRoomCall(pod);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const cardRef = useRef<HTMLElement | null>(null);

  // On a short screen the card opens under the seats, below the fold.
  useEffect(() => cardRef.current?.scrollIntoView({ block: 'nearest' }), [asking]);

  const self = person.peerId === pod.myPeerId;
  const proRoom = pod.governanceMode === 'ADMIN';
  const owner = pod.myRole === 'OWNER';
  const canRemove =
    proRoom && (owner || pod.myRole === 'ADMIN') && person.role !== 'OWNER';
  const calling =
    dmSession.status !== 'idle' &&
    dmSession.podId === pod.podId &&
    dmSession.peerId === person.peerId;

  const admin = useMutation({
    mutationFn: (req: { path: 'kick' | 'role'; role?: 'ADMIN' | 'MEMBER' }) =>
      apiFetch<{ pod: PodDetail }>(`/api/pods/${pod.podId}/admin/${req.path}`, {
        method: 'POST',
        body: JSON.stringify({ targetPeerId: person.peerId, role: req.role }),
      }),
    onSuccess: (res) => mergeRoster(res.pod),
  });

  const voteOut = useMutation({
    mutationFn: () =>
      apiFetch<{ proposal: PodProposalDto; pod?: PodDetail | null }>(
        `/api/pods/${pod.podId}/proposals`,
        {
          method: 'POST',
          body: JSON.stringify({
            kind: 'KICK_MEMBER',
            targetPeerId: person.peerId,
            reason: reason.trim() || undefined,
          }),
        }
      ),
    onSuccess: (res) => {
      syncProposalIntoCaches(queryClient, pod.podId, res.proposal, res.pod);
      queryClient.invalidateQueries({ queryKey: ['proposals', pod.podId] });
      queryClient.invalidateQueries({ queryKey: ['messages', pod.podId, 'group'] });
      setRightPanel('votes');
    },
  });

  const error = admin.error ?? voteOut.error;
  const inCall = person.inVoice || peers.some((p) => p.peerId === person.peerId);

  return (
    <article ref={cardRef} className={s.card} style={colorVar(person.alias)} aria-label={person.alias}>
      <div>
        <h3>{person.alias}</h3>
        <p>
          {self ? 'This is you, in this room only' : where(person, inCall)}
          {person.role === 'OWNER' && '. Runs this group'}
          {person.role === 'ADMIN' && '. Helps run this group'}
        </p>
        {person.customStatus && !self && <p>{person.customStatus}</p>}
      </div>

      {error && (
        <p className={ui.alert} role="alert">
          {error.message}
        </p>
      )}

      {self ? (
        <StatusForm pod={pod} />
      ) : asking ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            voteOut.mutate();
          }}
        >
          <label className={ui.field}>
            <span>Why should the room remove {person.alias}?</span>
            <input
              className={`${ui.input} ${ui.onColor}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={140}
              placeholder="Optional, shown on the vote"
            />
          </label>
          <div className={s.cardBtns}>
            <button type="button" className={`${ui.btn} ${ui.glass}`} onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button type="submit" className={`${ui.btn} ${ui.ink}`} disabled={voteOut.isPending}>
              Start vote
            </button>
          </div>
        </form>
      ) : (
        <div className={s.cardBtns}>
          {/* The chat's own header already writes and calls. */}
          {!chatting && (
            <>
              <button
                type="button"
                className={`${ui.btn} ${ui.ink}`}
                onClick={() => openConversation(pod.podId, person.peerId)}
              >
                Write
              </button>
              <button
                type="button"
                className={`${ui.btn} ${ui.glass}`}
                disabled={calling}
                onClick={() => {
                  openConversation(pod.podId, person.peerId);
                  startDmCall(pod.podId, person.peerId, person.alias, person.color);
                }}
              >
                {calling ? 'In a call' : 'Call'}
              </button>
            </>
          )}
          {!proRoom && (
            <button
              type="button"
              className={`${ui.btn} ${ui.glass} ${s.span}`}
              onClick={() => setAsking(true)}
            >
              Vote to remove
            </button>
          )}
          {canRemove && owner && (
            <button
              type="button"
              className={`${ui.btn} ${ui.glass}`}
              disabled={admin.isPending}
              onClick={() =>
                admin.mutate({
                  path: 'role',
                  role: person.role === 'ADMIN' ? 'MEMBER' : 'ADMIN',
                })
              }
            >
              {person.role === 'ADMIN' ? 'Take admin away' : 'Make admin'}
            </button>
          )}
          {canRemove && (
            <button
              type="button"
              className={`${ui.btn} ${ui.glass} ${owner ? '' : s.span}`}
              disabled={admin.isPending}
              onClick={() => admin.mutate({ path: 'kick' })}
            >
              Remove
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export function useSaveStatus(pod: PodDetail) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (customStatus: string) =>
      apiFetch<{ ok: boolean }>(`/api/pods/${pod.podId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ customStatus }),
      }).then(() => customStatus),
    onSuccess: (customStatus) =>
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) =>
        old && {
          pods: old.pods.map((p) =>
            p.podId === pod.podId ? { ...p, myStatus: customStatus } : p
          ),
        }
      ),
  });
}

export function StatusForm({
  pod,
  onSaved,
}: {
  pod: PodDetail;
  onSaved?: () => void;
}) {
  const [line, setLine] = useState(pod.myStatus);
  const save = useSaveStatus(pod);

  useEffect(() => setLine(pod.myStatus), [pod.myStatus]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(line.trim(), { onSuccess: onSaved });
  };

  return (
    <form className={ui.field} onSubmit={submit}>
      <label className={ui.label} htmlFor={`status-${pod.podId}`}>
        A line under your alias
      </label>
      <div className={`${ui.row} ${ui.nowrap}`}>
        <input
          id={`status-${pod.podId}`}
          className={`${ui.input} ${ui.onColor} ${ui.grow}`}
          value={line}
          onChange={(e) => setLine(e.target.value)}
          maxLength={80}
          placeholder="Two rounds, then bed"
        />
        <button type="submit" className={`${ui.btn} ${ui.ink}`} disabled={save.isPending}>
          {save.isSuccess && line.trim() === pod.myStatus ? 'Saved' : 'Save'}
        </button>
      </div>
      {save.error && (
        <p className={ui.alert} role="alert">
          {save.error.message}
        </p>
      )}
    </form>
  );
}

function AboutRoom({ pod, pods }: { pod: PodDetail; pods: PodDetail[] }) {
  const queryClient = useQueryClient();
  const setInvitePod = useSetAtom(inviteModalPodIdAtom);
  const setSettingsPod = useSetAtom(adminSettingsPodIdAtom);
  const leave = useLeaveRoom(pods);
  const [leaving, setLeaving] = useState(false);
  const proRoom = pod.governanceMode === 'ADMIN';
  const canManage = proRoom && (pod.myRole === 'OWNER' || pod.myRole === 'ADMIN');

  const toggleMute = useMutation({
    mutationFn: (muted: boolean) =>
      apiFetch<{ ok: boolean; muted: boolean }>(`/api/pods/${pod.podId}/mute`, {
        method: 'PATCH',
        body: JSON.stringify({ muted }),
      }),
    onSuccess: (res) =>
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) =>
        old && {
          pods: old.pods.map((p) =>
            p.podId === pod.podId ? { ...p, myMuted: res.muted } : p
          ),
        }
      ),
  });

  return (
    <section className={s.about} aria-label="About this room">
      <div>
        <h3>{pod.title || `A room for ${pod.interestLabel}`}</h3>
        {pod.description && <p>{pod.description}</p>}
        <p className={s.muted}>
          {proRoom
            ? `Run by its owner. ${pod.isPublicized ? 'Listed for anyone to join.' : 'Invite only.'}`
            : 'Nobody owns it. Changes pass by vote.'}
          {pod.myMuted ? ' Muted.' : ''}
        </p>
      </div>
      {(leave.error || toggleMute.error) && (
        <p className={ui.alert} role="alert">
          {(leave.error ?? toggleMute.error)?.message}
        </p>
      )}
      {leaving ? (
        <>
          <p>
            {proRoom
              ? 'Leave this group? Coming back takes an invite or the directory.'
              : 'Leave for good? Matching will not put you back in this room.'}
          </p>
          <div className={s.cardBtns}>
            <button type="button" className={ui.btn} onClick={() => setLeaving(false)}>
              Stay
            </button>
            <button
              type="button"
              className={`${ui.btn} ${ui.off}`}
              style={{ background: 'var(--off)' }}
              disabled={leave.isPending}
              onClick={() => leave.mutate({ podId: pod.podId, rematch: false })}
            >
              Leave
            </button>
            {!proRoom && (
              <button
                type="button"
                className={`${ui.btn} ${s.span}`}
                disabled={leave.isPending}
                onClick={() => leave.mutate({ podId: pod.podId, rematch: true })}
              >
                Swap it for another {pod.interestLabel} room
              </button>
            )}
          </div>
        </>
      ) : (
        <div className={s.cardBtns}>
          <button type="button" className={ui.btn} onClick={() => setInvitePod(pod.podId)}>
            Invite
          </button>
          <button
            type="button"
            className={ui.btn}
            aria-pressed={Boolean(pod.myMuted)}
            disabled={toggleMute.isPending}
            onClick={() => toggleMute.mutate(!pod.myMuted)}
          >
            {pod.myMuted ? 'Unmute' : 'Mute'}
          </button>
          {canManage ? (
            <button type="button" className={ui.btn} onClick={() => setSettingsPod(pod.podId)}>
              Manage
            </button>
          ) : null}
          <button
            type="button"
            className={`${ui.btn} ${canManage ? '' : s.span}`}
            onClick={() => setLeaving(true)}
          >
            Leave
          </button>
        </div>
      )}
    </section>
  );
}

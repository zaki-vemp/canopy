'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAtom } from 'jotai';
import { apiFetch } from '@/lib/api';
import { colorVar } from '@/lib/pieces';
import { inviteModalPodIdAtom } from '@/state/workspaceAtoms';
import { roomName, useMembers } from '@/state/roomActions';
import { Dialog } from '@/components/pieces/Dialog';
import type { CreateInviteRequest, PodDetail, PodInviteDto } from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import d from './dialogs.module.css';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.cssText = 'position:fixed;opacity:0';
    document.body.append(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    return ok;
  }
}

function expiry(expiresAt: string | null): string {
  const ts = Date.parse(expiresAt ?? '');
  if (Number.isNaN(ts)) return 'Never runs out';
  const hours = Math.max(0, Math.round((ts - Date.now()) / 3_600_000));
  if (hours < 1) return 'Runs out within the hour';
  return hours < 48 ? `Runs out in ${hours} hours` : `Runs out in ${Math.round(hours / 24)} days`;
}

export function InviteDialog({ pods }: { pods: PodDetail[] }) {
  const [podId, setPodId] = useAtom(inviteModalPodIdAtom);
  const pod = pods.find((p) => p.podId === podId);
  return pod ? <Invite key={pod.podId} pod={pod} onClose={() => setPodId(null)} /> : null;
}

function Invite({ pod, onClose }: { pod: PodDetail; onClose: () => void }) {
  const members = useMembers(pod);
  const [invite, setInvite] = useState<PodInviteDto | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);
  const [hours, setHours] = useState(168);
  const [uses, setUses] = useState(0);

  const call = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      setDone(null);
      try {
        await work();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That did not work. Try again.');
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const fetchInvite = useCallback(
    (req: CreateInviteRequest) =>
      call(async () => {
        const res = await apiFetch<{ invite: PodInviteDto }>(`/api/pods/${pod.podId}/invites`, {
          method: 'POST',
          body: JSON.stringify(req),
        });
        setInvite(res.invite);
        setUses(res.invite.maxUses);
        if (res.invite.expiresAt === null) setHours(0);
        if (req.regenerate) setDone('The new link is ready.');
      }),
    [call, pod.podId]
  );

  useEffect(() => {
    fetchInvite({ maxUses: 0, expiresInHours: 168, regenerate: false });
  }, [fetchInvite]);

  const link = invite ? `${window.location.origin}/invite/${invite.code}` : '';
  const copyIt = async (what: 'link' | 'code', value: string) => {
    if (await copy(value)) {
      setCopied(what);
      setTimeout(() => setCopied((cur) => (cur === what ? null : cur)), 1800);
    }
  };
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <Dialog
      title={`Invite to ${roomName(pod)}`}
      lead="Whoever comes in gets an alias. Your name is not on the link."
      onClose={onClose}
    >
      {error && (
        <p className={ui.alert} role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className={ui.done} role="status">
          {done}
        </p>
      )}

      {invite && (
        <div className={d.ticket} style={colorVar(pod.myAlias)}>
          <code>{link.replace(/^https?:\/\//, '')}</code>
          <div className={ui.row}>
            <button type="button" className={`${ui.btn} ${ui.ink}`} onClick={() => copyIt('link', link)}>
              {copied === 'link' ? 'Copied' : 'Copy link'}
            </button>
            <button type="button" className={`${ui.btn} ${ui.glass}`} onClick={() => copyIt('code', invite.code)}>
              {copied === 'code' ? 'Copied' : 'Copy code only'}
            </button>
            {canShare && (
              <button
                type="button"
                className={`${ui.btn} ${ui.glass}`}
                onClick={() =>
                  navigator
                    .share({
                      title: `${roomName(pod)} on Canopy`,
                      text: `A ${pod.interestLabel} room on Canopy. You come in under an alias.`,
                      url: link,
                    })
                    .catch(() => {})
                }
              >
                Share
              </button>
            )}
          </div>
          <p>
            {invite.maxUses > 0
              ? `Used ${invite.usesCount} of ${invite.maxUses} times. `
              : `Used ${invite.usesCount} times. `}
            {expiry(invite.expiresAt)}.
            {members.length >= pod.maxMembers && ' The room is full right now.'}
          </p>
        </div>
      )}

      <div className={ui.two}>
        <label className={ui.field}>
          <span>Works for</span>
          <select className={ui.input} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={24}>A day</option>
            <option value={168}>A week</option>
            <option value={0}>Always</option>
          </select>
        </label>
        <label className={ui.field}>
          <span>Lets in</span>
          <select className={ui.input} value={uses} onChange={(e) => setUses(Number(e.target.value))}>
            <option value={0}>Anyone with the link</option>
            <option value={1}>1 person</option>
            <option value={5}>5 people</option>
            <option value={10}>10 people</option>
          </select>
        </label>
      </div>
      <div className={ui.row}>
        <button
          type="button"
          className={ui.btn}
          disabled={busy}
          onClick={() => fetchInvite({ maxUses: uses, expiresInHours: hours, regenerate: true })}
        >
          Make a new link
        </button>
        {invite && (
          <button
            type="button"
            className={`${ui.btn} ${ui.off}`}
            disabled={busy}
            onClick={() =>
              call(async () => {
                await apiFetch<{ ok: boolean }>(
                  `/api/pods/${pod.podId}/invites/${encodeURIComponent(invite.code)}`,
                  { method: 'DELETE' }
                );
                setInvite(null);
                setDone('That link no longer works.');
              })
            }
          >
            Cancel this link
          </button>
        )}
        {invite && (
          <a
            className={ui.btn}
            href={`/invite/${encodeURIComponent(invite.code)}?fresh=1`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Try it as someone else
          </a>
        )}
      </div>
    </Dialog>
  );
}

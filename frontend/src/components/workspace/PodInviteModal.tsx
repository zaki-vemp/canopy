'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import {
  Check,
  Copy,
  ExternalLink,
  RefreshCw,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import {
  inviteModalPodIdAtom,
  presenceByPodAtom,
} from '@/state/workspaceAtoms';
import {
  getPodTierLabel,
  type CreateInviteRequest,
  type PodDetail,
  type PodInviteDto,
} from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

const EXPIRY_OPTIONS = [
  { value: 24, label: '24 hours' },
  { value: 168, label: '7 days' },
  { value: 0, label: 'Never' },
] as const;

const MAX_USES_OPTIONS = [
  { value: 0, label: 'Unlimited' },
  { value: 1, label: '1 use' },
  { value: 5, label: '5 uses' },
  { value: 10, label: '10 uses' },
] as const;

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to textarea fallback
    }
  }
  if (typeof document === 'undefined') return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

function formatExpiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return 'Never expires';
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) return expiresAt;
  const diffHours = Math.max(0, Math.round((ts - Date.now()) / 3_600_000));
  if (diffHours < 1) return 'Expires in < 1 hour';
  if (diffHours < 48) return `Expires in ~${diffHours}h`;
  return `Expires in ~${Math.round(diffHours / 24)}d`;
}

export function PodInviteModal({ pods }: { pods: PodDetail[] }) {
  const [podId, setPodId] = useAtom(inviteModalPodIdAtom);
  const presenceByPod = useAtomValue(presenceByPodAtom);

  const pod = pods.find((p) => p.podId === podId) ?? null;

  const [invite, setInvite] = useState<PodInviteDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [expiresInHours, setExpiresInHours] = useState<number>(168);
  const [maxUses, setMaxUses] = useState<number>(0);

  const [copiedField, setCopiedField] = useState<'link' | 'code' | null>(null);

  const canNativeShare =
    typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const createOrFetchInvite = useCallback(
    async (targetPodId: string, req: CreateInviteRequest, isRegen = false) => {
      if (isRegen) {
        setRegenerating(true);
      } else {
        setLoading(true);
      }
      setErrorMsg(null);
      setStatusMsg(null);
      try {
        const res = await apiFetch<{ invite: PodInviteDto }>(
          `/api/pods/${targetPodId}/invites`,
          {
            method: 'POST',
            body: JSON.stringify(req),
          }
        );
        setInvite(res.invite);
        setMaxUses(res.invite.maxUses);
        if (res.invite.expiresAt === null) {
          setExpiresInHours(0);
        }
        if (isRegen) {
          setStatusMsg('Generated a fresh invite link.');
        }
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : 'Could not create invite link.'
        );
      } finally {
        setLoading(false);
        setRegenerating(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!podId) {
      setInvite(null);
      setErrorMsg(null);
      setStatusMsg(null);
      setCopiedField(null);
      return;
    }
    setExpiresInHours(168);
    setMaxUses(0);
    createOrFetchInvite(
      podId,
      { maxUses: 0, expiresInHours: 168, regenerate: false },
      false
    );
  }, [createOrFetchInvite, podId]);

  useEffect(() => {
    if (!podId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPodId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [podId, setPodId]);

  if (!podId) return null;

  const origin =
    typeof window !== 'undefined'
      ? window.location.origin
      : 'http://localhost:3001';
  const shareUrl = invite ? `${origin}/invite/${invite.code}` : '';

  const liveOccupancy = pod
    ? presenceByPod[pod.podId]?.members.length || pod.memberCount
    : invite?.memberCount ?? 0;
  const maxMembers = pod?.maxMembers ?? invite?.maxMembers ?? 25;
  const podCode = pod?.code ?? invite?.podCode ?? 'pod';
  const podTitle = pod?.title || invite?.podTitle || '';
  const interestLabel = pod?.interestLabel ?? invite?.interestLabel ?? 'Pod';
  const tierLabel = getPodTierLabel(maxMembers);

  const handleCopy = async (kind: 'link' | 'code', value: string) => {
    const ok = await copyTextToClipboard(value);
    if (ok) {
      setCopiedField(kind);
      setTimeout(() => {
        setCopiedField((cur) => (cur === kind ? null : cur));
      }, 1800);
    }
  };

  const handleNativeShare = async () => {
    if (!invite || !canNativeShare) return;
    try {
      await navigator.share({
        title: `Join #${podCode} on Canopy`,
        text: `Join blind ${interestLabel} pod #${podCode} on Canopy — everyone gets a random animal alias:`,
        url: shareUrl,
      });
    } catch {
      // user cancelled OS share sheet
    }
  };

  const handleRevoke = async () => {
    if (!podId || !invite || revoking) return;
    setRevoking(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await apiFetch<{ ok: boolean }>(
        `/api/pods/${podId}/invites/${encodeURIComponent(invite.code)}`,
        { method: 'DELETE' }
      );
      setInvite(null);
      setStatusMsg('Invite link revoked. Generate a new link whenever ready.');
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not revoke invite link.'
      );
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div
      className={`${styles.modalOverlay} ${styles.inviteModalOverlay}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pod-invite-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) setPodId(null);
      }}
    >
      <div className={styles.modalCard} style={{ maxWidth: 560 }}>
        <div className={styles.modalHeader}>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <h2
                id="pod-invite-modal-title"
                style={{ margin: 0, fontSize: 18 }}
              >
                Share &amp; Invite to{' '}
                {podTitle ? `${podTitle} (#${podCode})` : `#${podCode}`}
              </h2>
              <span className={styles.interestBadge}>{interestLabel}</span>
              <span className={styles.tierBadge}>
                {tierLabel} · {liveOccupancy}/{maxMembers}
              </span>
            </div>
            <p style={{ margin: '4px 0 0', fontSize: 12.5, color: '#686868' }}>
              Invited peers receive a random animal alias — real names, emails,
              genders &amp; nationalities stay hidden.
            </p>
          </div>
          <button
            type="button"
            className={styles.composerIconBtn}
            onClick={() => setPodId(null)}
            aria-label="Close invite modal"
          >
            <X size={18} />
          </button>
        </div>

        <div
          className={styles.modalBody}
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          {errorMsg && (
            <div
              style={{
                padding: '9px 12px',
                borderRadius: 8,
                background: '#fef3f2',
                color: '#b42318',
                fontSize: 13,
              }}
              role="alert"
            >
              {errorMsg}
            </div>
          )}

          {statusMsg && (
            <div
              style={{
                padding: '9px 12px',
                borderRadius: 8,
                background: '#eafbef',
                border: '1px solid rgba(31,107,58,0.28)',
                color: '#154726',
                fontSize: 13,
                fontWeight: 600,
              }}
              role="status"
            >
              {statusMsg}
            </div>
          )}

          {loading ? (
            <p style={{ margin: 0, fontSize: 13.5, color: '#686868' }}>
              Preparing shareable blind pod invite link...
            </p>
          ) : invite ? (
            <>
              {/* Shareable Invite Link */}
              <div className={styles.inviteFieldGroup}>
                <span className={styles.podOptionLabel}>
                  Shareable Invite Link
                </span>
                <div className={styles.inviteFieldRow}>
                  <div className={styles.inviteMonoBox} title={shareUrl}>
                    {shareUrl}
                  </div>
                  <button
                    type="button"
                    className={styles.primaryActionBtn}
                    onClick={() => handleCopy('link', shareUrl)}
                    aria-label="Copy invite link"
                  >
                    {copiedField === 'link' ? (
                      <>
                        <Check size={15} />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy size={15} />
                        <span>Copy Link</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Bare Invite Code */}
              <div className={styles.inviteFieldGroup}>
                <span className={styles.podOptionLabel}>Invite Code</span>
                <div className={styles.inviteFieldRow}>
                  <div className={styles.inviteMonoBox}>{invite.code}</div>
                  <button
                    type="button"
                    className={styles.secondaryActionBtn}
                    onClick={() => handleCopy('code', invite.code)}
                    aria-label="Copy invite code"
                  >
                    {copiedField === 'code' ? (
                      <>
                        <Check size={15} />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy size={15} />
                        <span>Copy Code</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Active Invite Telemetry */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '6px 14px',
                  fontFamily: 'var(--m-font-mono)',
                  fontSize: 11.5,
                  color: '#555555',
                }}
              >
                <span>
                  Uses: {invite.usesCount}
                  {invite.maxUses > 0 ? ` / ${invite.maxUses}` : ' (Unlimited)'}
                </span>
                <span>·</span>
                <span>{formatExpiryLabel(invite.expiresAt)}</span>
                {invite.isFull && (
                  <>
                    <span>·</span>
                    <strong style={{ color: '#b42318' }}>
                      Pod currently full ({invite.memberCount}/
                      {invite.maxMembers})
                    </strong>
                  </>
                )}
              </div>

              {/* Native Mobile Share + One-Click Isolated 2nd Tab Tester */}
              <div className={styles.inviteQuickActions}>
                {canNativeShare && (
                  <button
                    type="button"
                    className={styles.primaryActionBtn}
                    onClick={handleNativeShare}
                  >
                    <Share2 size={15} />
                    <span>Share...</span>
                  </button>
                )}

                <button
                  type="button"
                  className={styles.secondaryActionBtn}
                  onClick={() =>
                    window.open(
                      `/invite/${encodeURIComponent(invite.code)}?fresh=1`,
                      '_blank',
                      'noopener,noreferrer'
                    )
                  }
                >
                  <ExternalLink size={15} />
                  <span>Open Invite in Isolated 2nd Tab (?fresh=1)</span>
                </button>
              </div>
            </>
          ) : null}

          {/* Link Settings: Custom / Regenerate / Revoke */}
          <div className={styles.inviteSettingsBox}>
            <div className={styles.podOptionLabel}>
              Create Custom / Regenerate Link
            </div>

            <div className={styles.inviteSettingsGrid}>
              <label className={styles.inviteFieldGroup}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                  Expires after
                </span>
                <select
                  className={styles.inviteSelect}
                  value={expiresInHours}
                  onChange={(e) => setExpiresInHours(Number(e.target.value))}
                  aria-label="Invite link expiration"
                >
                  {EXPIRY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className={styles.inviteFieldGroup}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                  Max uses
                </span>
                <select
                  className={styles.inviteSelect}
                  value={maxUses}
                  onChange={(e) => setMaxUses(Number(e.target.value))}
                  aria-label="Invite link maximum uses"
                >
                  {MAX_USES_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                justifyContent: 'space-between',
              }}
            >
              <button
                type="button"
                className={styles.secondaryActionBtn}
                disabled={regenerating || loading}
                onClick={() =>
                  createOrFetchInvite(
                    podId,
                    {
                      maxUses,
                      expiresInHours,
                      regenerate: true,
                    },
                    true
                  )
                }
              >
                <RefreshCw size={15} />
                <span>
                  {regenerating ? 'Generating...' : 'Generate New Link'}
                </span>
              </button>

              {invite && (
                <button
                  type="button"
                  className={styles.leaveBtn}
                  style={{ flex: '0 0 auto' }}
                  disabled={revoking || loading}
                  onClick={handleRevoke}
                >
                  <Trash2 size={15} />
                  <span>{revoking ? 'Revoking...' : 'Revoke Link'}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

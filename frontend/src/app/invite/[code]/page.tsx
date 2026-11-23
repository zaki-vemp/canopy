'use client';

import React, { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useSetAtom } from 'jotai';
import {
  API_BASE,
  ApiError,
  apiFetch,
  clearAuthToken,
  enableTabIsolatedMode,
  getAuthToken,
  isTabIsolatedMode,
} from '@/lib/api';
import { activePodIdAtom } from '@/state/workspaceAtoms';
import {
  extractInviteCode,
  getPodTierLabel,
  type AcceptInviteResponse,
  type MatchRequest,
  type PodDetail,
  type PodInviteDto,
} from '@/types/canopy';
import styles from '../../auth.module.css';

async function fetchPublicInvite(code: string): Promise<PodInviteDto> {
  const res = await fetch(
    `${API_BASE}/api/invites/${encodeURIComponent(code)}`,
    { cache: 'no-store' }
  );
  if (!res.ok) {
    let msg =
      res.status === 404
        ? 'This pod invite link was not found.'
        : `Could not load invite (${res.status})`;
    try {
      const errJson = await res.json();
      msg = errJson.error || errJson.message || msg;
    } catch {
      // ignore json parse failure
    }
    throw new ApiError(res.status, msg);
  }
  const data = (await res.json()) as { invite: PodInviteDto };
  return data.invite;
}

function InviteLandingContent() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const setActivePodId = useSetAtom(activePodIdAtom);

  const code = extractInviteCode(params?.code || '');
  const freshParam = searchParams.get('fresh') === '1';

  const [ready, setReady] = useState(false);
  const [tabIsolated, setTabIsolated] = useState(freshParam);
  const [hasToken, setHasToken] = useState(false);
  const [freshChoiceMode, setFreshChoiceMode] = useState(false);

  const [invite, setInvite] = useState<PodInviteDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [matchingOpen, setMatchingOpen] = useState(false);

  const loadInvite = useCallback(async () => {
    if (!code) {
      setLoadError('Invalid invite code.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const dto = await fetchPublicInvite(code);
      setInvite(dto);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Could not load pod invite.'
      );
    } finally {
      setLoading(false);
    }
  }, [code]);

  useEffect(() => {
    if (freshParam) {
      enableTabIsolatedMode();
      setTabIsolated(true);
    } else if (isTabIsolatedMode()) {
      setTabIsolated(true);
    }
    setHasToken(Boolean(getAuthToken()));
    setReady(true);
  }, [freshParam]);

  useEffect(() => {
    loadInvite();
  }, [loadInvite]);

  const handleSwitchToFreshTabAccount = () => {
    enableTabIsolatedMode();
    clearAuthToken();
    setTabIsolated(true);
    setHasToken(false);
    setFreshChoiceMode(true);
    setActionError(null);
  };

  const handleAcceptInvite = async () => {
    if (!code || accepting) return;
    setAccepting(true);
    setActionError(null);
    try {
      const res = await apiFetch<AcceptInviteResponse>(
        `/api/invites/${encodeURIComponent(code)}/accept`,
        { method: 'POST' }
      );
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], {
        pods: res.pods,
      });
      queryClient.invalidateQueries({ queryKey: ['interests'] });
      setActivePodId(res.pod.podId);
      router.push(tabIsolated ? '/app?fresh=1' : '/app');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearAuthToken();
        setHasToken(false);
        setActionError(
          'Your login session expired — sign in or create an account to join this pod.'
        );
      } else {
        setActionError(
          err instanceof Error ? err.message : 'Could not accept pod invite.'
        );
        loadInvite();
      }
    } finally {
      setAccepting(false);
    }
  };

  const handleMatchAnotherOpenPod = async () => {
    if (!invite || matchingOpen) return;
    if (!hasToken || freshChoiceMode) {
      router.push(tabIsolated ? '/register?fresh=1' : '/register');
      return;
    }
    setMatchingOpen(true);
    setActionError(null);
    try {
      const payload: MatchRequest = {
        interest: invite.interestSlug,
        matchAll: false,
        allowAdditional: true,
      };
      const res = await apiFetch<{ matched: PodDetail[]; pods: PodDetail[] }>(
        '/api/pods/match',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        }
      );
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], {
        pods: res.pods,
      });
      queryClient.invalidateQueries({ queryKey: ['interests'] });
      const target = res.matched[0] || res.pods[res.pods.length - 1];
      if (target) {
        setActivePodId(target.podId);
      }
      router.push(tabIsolated ? '/app?fresh=1' : '/app');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearAuthToken();
        setHasToken(false);
        router.push(tabIsolated ? '/login?fresh=1' : '/login');
      } else {
        setActionError(
          err instanceof Error
            ? err.message
            : 'Could not match into an open pod.'
        );
      }
    } finally {
      setMatchingOpen(false);
    }
  };

  const inviteQuery = code
    ? `invite=${encodeURIComponent(code)}${tabIsolated ? '&fresh=1' : ''}`
    : tabIsolated
      ? 'fresh=1'
      : '';
  const registerHref = `/register${inviteQuery ? `?${inviteQuery}` : ''}`;
  const loginHref = `/login${inviteQuery ? `?${inviteQuery}` : ''}`;

  if (!ready || loading) {
    return (
      <div className={styles.inviteWrap}>
        <div className={styles.inviteCard}>
          <span className={styles.kicker}>
            <span className={styles.kickerDot} aria-hidden="true" />
            Checking blind pod invite...
          </span>
          <p className={styles.lead} style={{ fontSize: 16 }}>
            Loading pod seat count and room details...
          </p>
        </div>
      </div>
    );
  }

  if (loadError || !invite) {
    return (
      <div className={styles.inviteWrap}>
        <div className={styles.inviteCard}>
          <span className={styles.kicker}>Pod Invite Not Found</span>
          <h1 className={styles.invitePodTitle}>Invite unavailable</h1>
          <p className={styles.formAlert} role="alert">
            {loadError || 'This invite code does not match an active blind pod.'}
          </p>
          <div className={styles.inviteActionsStack}>
            <Link
              href={
                hasToken
                  ? tabIsolated
                    ? '/app?fresh=1'
                    : '/app'
                  : tabIsolated
                    ? '/register?fresh=1'
                    : '/register'
              }
              className={styles.mintPrimaryBtn}
            >
              {hasToken
                ? 'Open Canopy Workspace'
                : 'Browse Open 25-Member Blind Pods'}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const tierLabel = getPodTierLabel(invite.maxMembers);
  const maxUsesReached =
    !invite.canAccept &&
    !invite.isRevoked &&
    !invite.isExpired &&
    !invite.isFull;
  const unavailable =
    invite.isRevoked || invite.isExpired || invite.isFull || maxUsesReached;
  const showSignedInAccept = hasToken && !freshChoiceMode;

  return (
    <div className={styles.inviteWrap}>
      <div className={styles.inviteCard}>
        <div className={styles.invitePillsRow}>
          <span className={styles.inviteInterestPill}>
            {invite.interestLabel}
          </span>
          <span
            className={`${styles.inviteOccupancyBadge} ${
              invite.isFull ? styles.inviteOccupancyFull : ''
            }`}
          >
            {invite.isFull
              ? `${invite.memberCount}/${invite.maxMembers} full · ${tierLabel}`
              : `${tierLabel} · ${invite.memberCount} / ${invite.maxMembers} seats`}
          </span>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <h1 className={styles.invitePodTitle}>
            {invite.podTitle
              ? `${invite.podTitle} (#${invite.podCode})`
              : `#${invite.podCode}`}
          </h1>
          <p className={styles.invitedByLine}>
            <span className={styles.kickerDot} aria-hidden="true" />
            <span>
              Invited by <strong>{invite.invitedByAlias}</strong>
            </span>
          </p>
        </div>

        <div
          className={styles.guaranteeBox}
          role="note"
          aria-label="Blind Pod Guarantee"
        >
          <div className={styles.guaranteeTitle}>
            25-Member Blind Pod Guarantee
          </div>
          <p className={styles.guaranteeText}>
            You&apos;ll enter this 25-member blind pod with a random animal
            alias — neither <strong>{invite.invitedByAlias}</strong> nor anyone
            in <strong>#{invite.podCode}</strong> sees your real name, email,
            gender, or nationality.
          </p>
        </div>

        {tabIsolated && (
          <div className={styles.tabBadge}>
            <strong>Tab-isolated peer mode (?fresh=1):</strong> Joining from
            this tab uses an independent session so you can test multi-peer chat
            and voice side by side.
          </div>
        )}

        {actionError && (
          <p className={styles.formAlert} role="alert">
            {actionError}
          </p>
        )}

        {invite.isRevoked && (
          <div className={styles.formAlert} role="status">
            This invite link was revoked by a member of #{invite.podCode}. You
            can still match into another open {invite.interestLabel} pod below.
          </div>
        )}

        {!invite.isRevoked && invite.isExpired && (
          <div className={styles.formAlert} role="status">
            This invite link has expired. Ask a peer in #{invite.podCode} for a
            fresh link or match into another open {invite.interestLabel} pod.
          </div>
        )}

        {!invite.isRevoked && !invite.isExpired && maxUsesReached && (
          <div className={styles.formAlert} role="status">
            This invite link reached its maximum use limit ({invite.maxUses}{' '}
            {invite.maxUses === 1 ? 'use' : 'uses'}). You can match into another
            open {invite.interestLabel} pod below.
          </div>
        )}

        {!invite.isRevoked && !invite.isExpired && invite.isFull && (
          <div className={styles.formAlert} role="status">
            #{invite.podCode} is currently {invite.memberCount}/
            {invite.maxMembers} full. Jump into another open{' '}
            {invite.interestLabel} room right away.
          </div>
        )}

        {unavailable ? (
          <div className={styles.inviteActionsStack}>
            <button
              type="button"
              className={styles.mintPrimaryBtn}
              onClick={handleMatchAnotherOpenPod}
              disabled={matchingOpen}
            >
              {matchingOpen
                ? `Matching ${invite.interestLabel} pod...`
                : `Match into another open ${invite.interestLabel} pod`}
            </button>
            {invite.isFull && showSignedInAccept && (
              <button
                type="button"
                className={styles.secondaryBtnLink}
                onClick={handleAcceptInvite}
                disabled={accepting}
              >
                {accepting
                  ? 'Checking membership...'
                  : `Already in #${invite.podCode}? Open Pod`}
              </button>
            )}
          </div>
        ) : showSignedInAccept ? (
          <div className={styles.inviteActionsStack}>
            <button
              type="button"
              className={styles.mintPrimaryBtn}
              onClick={handleAcceptInvite}
              disabled={accepting}
            >
              {accepting
                ? `Joining #${invite.podCode}...`
                : `Accept Invite & Join #${invite.podCode}`}
            </button>
            <button
              type="button"
              className={styles.quietSwitchBtn}
              onClick={handleSwitchToFreshTabAccount}
            >
              Join with a fresh test account in this tab
            </button>
          </div>
        ) : (
          <div className={styles.inviteActionsStack}>
            <Link href={registerHref} className={styles.mintPrimaryBtn}>
              Create Account &amp; Join Pod
            </Link>
            <Link href={loginHref} className={styles.secondaryBtnLink}>
              Sign In &amp; Join Pod
            </Link>
            {!tabIsolated && (
              <button
                type="button"
                className={styles.quietSwitchBtn}
                onClick={handleSwitchToFreshTabAccount}
              >
                Join with a fresh test account in this tab
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function InviteLandingPage() {
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <Link href="/" className={styles.brand}>
            <svg
              className={styles.brandMark}
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="#a1ffcb"
            >
              <circle
                cx="6.5"
                cy="6.5"
                r="4.5"
                stroke="#232323"
                strokeWidth="1.2"
              />
              <circle
                cx="17.5"
                cy="6.5"
                r="4.5"
                stroke="#232323"
                strokeWidth="1.2"
              />
              <circle
                cx="6.5"
                cy="17.5"
                r="4.5"
                stroke="#232323"
                strokeWidth="1.2"
              />
              <rect
                x="13"
                y="13"
                width="9"
                height="9"
                rx="1.5"
                stroke="#232323"
                strokeWidth="1.2"
              />
            </svg>
            Canopy
          </Link>
          <div className={styles.topActions}>
            <Link href="/app" className={styles.ghostLink}>
              Open workspace
            </Link>
          </div>
        </div>
      </header>
      <main className={styles.main}>
        <Suspense fallback={<p>Loading pod invite...</p>}>
          <InviteLandingContent />
        </Suspense>
      </main>
    </div>
  );
}

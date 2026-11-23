'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useSetAtom } from 'jotai';
import {
  apiFetch,
  ApiError,
  enableTabIsolatedMode,
  isTabIsolatedMode,
  setAuthToken,
} from '@/lib/api';
import { authRevisionAtom } from '@/state/authAtoms';
import { activePodIdAtom } from '@/state/workspaceAtoms';
import {
  extractInviteCode,
  type AcceptInviteResponse,
  type PodDetail,
} from '@/types/canopy';
import styles from '../auth.module.css';

interface AuthResponse {
  token: string;
  user: {
    userId: string;
    email: string;
    fullName: string;
    gender: string;
    nationalityCode: string;
    planTier?: 'FREE' | 'PREMIUM';
  };
}

function LoginFormContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const bumpAuthRevision = useSetAtom(authRevisionAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const freshParam = searchParams.get('fresh') === '1';
  const inviteCode = extractInviteCode(searchParams.get('invite') || '');

  const [tabIsolated, setTabIsolated] = useState(freshParam);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (freshParam) {
      enableTabIsolatedMode();
      setTabIsolated(true);
    } else if (isTabIsolatedMode()) {
      setTabIsolated(true);
    }
  }, [freshParam]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setServerError('');

    const nextErrors: Record<string, string> = {};
    if (!email.trim() || !email.includes('@')) {
      nextErrors.email = 'Enter the email address for your account.';
    }
    if (!password) {
      nextErrors.password = 'Enter your account password.';
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      const useTabOnly = freshParam || isTabIsolatedMode();
      const endpoint = useTabOnly
        ? '/api/auth/login?tabOnly=true'
        : '/api/auth/login';
      const res = await apiFetch<AuthResponse>(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim(),
          password,
        }),
      });
      setAuthToken(res.token, useTabOnly);
      queryClient.clear();
      bumpAuthRevision((r) => r + 1);
      if (inviteCode) {
        try {
          const acceptRes = await apiFetch<AcceptInviteResponse>(
            `/api/invites/${encodeURIComponent(inviteCode)}/accept`,
            { method: 'POST' }
          );
          queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], {
            pods: acceptRes.pods,
          });
          setActivePodId(acceptRes.pod.podId);
          router.push(useTabOnly ? '/app?fresh=1' : '/app');
          return;
        } catch {
          router.push(
            `/invite/${encodeURIComponent(inviteCode)}${
              useTabOnly ? '?fresh=1' : ''
            }`
          );
          return;
        }
      }
      setActivePodId(null);
      router.push(useTabOnly ? '/app?fresh=1' : '/app');
    } catch (err) {
      if (err instanceof ApiError) {
        setServerError(err.message);
      } else {
        setServerError('Could not sign in. Check your credentials and connection.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const nextParams = new URLSearchParams();
  if (inviteCode) nextParams.set('invite', inviteCode);
  if (tabIsolated) nextParams.set('fresh', '1');
  const qs = nextParams.toString();
  const registerHref = `/register${qs ? `?${qs}` : ''}`;

  return (
    <div className={styles.authGrid}>
      <div className={styles.introCol}>
        <span className={styles.kicker}>
          <span className={styles.kickerDot} aria-hidden="true" />
          25 seats per room &middot; Peer-blind WebRTC voice
        </span>
        <h1 className={styles.title}>Sign in to Canopy</h1>
        <p className={styles.lead}>
          Return to your 25-member democratic rooms, live Yes-or-No pod votes, Canopy Pro custom groups, and drop-in voice channels.
        </p>

        <div className={styles.guaranteeBox} role="note" aria-label="Blind Pod Guarantee">
          <div className={styles.guaranteeTitle}>Blind Pod Guarantee</div>
          <p className={styles.guaranteeText}>
            Your name, email, gender, and nationality remain private to your login session and never appear in any democratic pod, Pro custom group, proposal vote, or voice roster.
          </p>
        </div>

        {inviteCode && (
          <div className={styles.inviteBanner} role="status">
            <span>Signing in to join invited pod</span>
            <span className={styles.inviteBannerCode}>invite/{inviteCode}</span>
          </div>
        )}

        {tabIsolated && (
          <div className={styles.tabBadge}>
            <strong>Tab-isolated session active:</strong> Signing in here keeps the token scoped to this tab only.
          </div>
        )}
      </div>

      <div className={styles.card}>
        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          {serverError && (
            <p className={styles.formAlert} role="alert">
              {serverError}
            </p>
          )}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-email">
              Email address
            </label>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              className={styles.input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? 'login-email-err' : undefined}
            />
            {errors.email && (
              <p id="login-email-err" className={styles.fieldError}>
                {errors.email}
              </p>
            )}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-password">
              Password
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              className={styles.input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? 'login-password-err' : undefined}
            />
            {errors.password && (
              <p id="login-password-err" className={styles.fieldError}>
                {errors.password}
              </p>
            )}
          </div>

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={submitting}
          >
            {submitting
              ? inviteCode
                ? 'Signing in & joining pod...'
                : 'Signing in...'
              : inviteCode
                ? 'Sign in & join invited pod'
                : 'Open the dashboard'}
          </button>
        </form>

        <p className={styles.switchLine}>
          <span>New to Canopy?</span>
          <Link href={registerHref} className={styles.inlineLink}>
            Create a new account
          </Link>
        </p>
      </div>
    </div>
  );
}

function TopRegisterLink() {
  const searchParams = useSearchParams();
  const nextParams = new URLSearchParams();
  const inviteCode = extractInviteCode(searchParams.get('invite') || '');
  if (inviteCode) nextParams.set('invite', inviteCode);
  if (searchParams.get('fresh') === '1') nextParams.set('fresh', '1');
  const qs = nextParams.toString();
  return (
    <Link
      href={`/register${qs ? `?${qs}` : ''}`}
      className={styles.ghostLink}
    >
      Create account
    </Link>
  );
}

export default function LoginPage() {
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
              <circle cx="6.5" cy="6.5" r="4.5" stroke="#232323" strokeWidth="1.2" />
              <circle cx="17.5" cy="6.5" r="4.5" stroke="#232323" strokeWidth="1.2" />
              <circle cx="6.5" cy="17.5" r="4.5" stroke="#232323" strokeWidth="1.2" />
              <rect x="13" y="13" width="9" height="9" rx="1.5" stroke="#232323" strokeWidth="1.2" />
            </svg>
            Canopy
          </Link>
          <div className={styles.topActions}>
            <Suspense
              fallback={
                <Link href="/register" className={styles.ghostLink}>
                  Create account
                </Link>
              }
            >
              <TopRegisterLink />
            </Suspense>
          </div>
        </div>
      </header>
      <main className={styles.main}>
        <Suspense fallback={<p>Loading sign-in form...</p>}>
          <LoginFormContent />
        </Suspense>
      </main>
    </div>
  );
}

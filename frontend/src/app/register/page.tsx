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

const GENDER_OPTIONS = [
  'Female',
  'Male',
  'Non-binary',
  'Prefer not to say',
] as const;

const NATIONALITY_OPTIONS = [
  { code: 'IN', label: 'India (IN)' },
  { code: 'US', label: 'United States (US)' },
  { code: 'GB', label: 'United Kingdom (GB)' },
  { code: 'DE', label: 'Germany (DE)' },
  { code: 'CA', label: 'Canada (CA)' },
  { code: 'AU', label: 'Australia (AU)' },
  { code: 'JP', label: 'Japan (JP)' },
  { code: 'SG', label: 'Singapore (SG)' },
  { code: 'BR', label: 'Brazil (BR)' },
  { code: 'FR', label: 'France (FR)' },
  { code: 'NL', label: 'Netherlands (NL)' },
  { code: 'SE', label: 'Sweden (SE)' },
  { code: 'KR', label: 'South Korea (KR)' },
  { code: 'AE', label: 'United Arab Emirates (AE)' },
  { code: 'ZA', label: 'South Africa (ZA)' },
  { code: 'MX', label: 'Mexico (MX)' },
  { code: 'ES', label: 'Spain (ES)' },
  { code: 'IT', label: 'Italy (IT)' },
  { code: 'PL', label: 'Poland (PL)' },
  { code: 'XX', label: 'Other (XX)' },
] as const;

function RegisterFormContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const bumpAuthRevision = useSetAtom(authRevisionAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const freshParam = searchParams.get('fresh') === '1';
  const inviteCode = extractInviteCode(searchParams.get('invite') || '');

  const [tabIsolated, setTabIsolated] = useState(freshParam);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [gender, setGender] = useState<string>('Prefer not to say');
  const [nationalityCode, setNationalityCode] = useState<string>('US');

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
    if (!fullName.trim()) {
      nextErrors.fullName = 'Enter your full name for private account verification.';
    }
    if (!email.trim() || !email.includes('@')) {
      nextErrors.email = 'Enter a valid email address with an @.';
    }
    if (password.length < 6) {
      nextErrors.password = 'Enter a password of at least 6 characters.';
    }
    if (!gender) {
      nextErrors.gender = 'Choose a gender option.';
    }
    if (!nationalityCode) {
      nextErrors.nationalityCode = 'Choose a nationality code.';
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      const useTabOnly = freshParam || isTabIsolatedMode();
      const endpoint = useTabOnly
        ? '/api/auth/register?tabOnly=true'
        : '/api/auth/register';
      const res = await apiFetch<AuthResponse>(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim(),
          password,
          fullName: fullName.trim(),
          gender,
          nationalityCode,
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
        setServerError('Could not create your account. Check that the backend is running.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const nextParams = new URLSearchParams();
  if (inviteCode) nextParams.set('invite', inviteCode);
  if (tabIsolated) nextParams.set('fresh', '1');
  const qs = nextParams.toString();
  const loginHref = `/login${qs ? `?${qs}` : ''}`;

  return (
    <div className={styles.authGrid}>
      <div className={styles.introCol}>
        <span className={styles.kicker}>
          <span className={styles.kickerDot} aria-hidden="true" />
          25 seats per room &middot; 0 public profiles
        </span>
        <h1 className={styles.title}>Create your Canopy account</h1>
        <p className={styles.lead}>
          Verify once, pick your interests, and match into 25-member democratic rooms where Yes-or-No votes run the pod, or launch custom admin groups on Canopy Pro.
        </p>

        <div className={styles.guaranteeBox} role="note" aria-label="Blind Pod Guarantee">
          <div className={styles.guaranteeTitle}>Blind Pod Guarantee</div>
          <p className={styles.guaranteeText}>
            Stored privately for account verification only. People in your democratic pods and Pro custom groups never see your name, email, gender, or nationality — only a random per-room alias like Cobalt Fox.
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
            <strong>Tab-isolated session active:</strong> This account token stays inside this browser tab&apos;s <code>sessionStorage</code> so you can test multiple independent peers side by side.
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
            <label className={styles.label} htmlFor="reg-name">
              Full name
            </label>
            <input
              id="reg-name"
              name="fullName"
              type="text"
              autoComplete="name"
              className={styles.input}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              aria-invalid={Boolean(errors.fullName)}
              aria-describedby={errors.fullName ? 'reg-name-err' : undefined}
            />
            {errors.fullName && (
              <p id="reg-name-err" className={styles.fieldError}>
                {errors.fullName}
              </p>
            )}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="reg-email">
              Email address
            </label>
            <input
              id="reg-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              className={styles.input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? 'reg-email-err' : undefined}
            />
            {errors.email && (
              <p id="reg-email-err" className={styles.fieldError}>
                {errors.email}
              </p>
            )}
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="reg-password">
              Password
            </label>
            <input
              id="reg-password"
              name="password"
              type="password"
              autoComplete="new-password"
              className={styles.input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? 'reg-password-err' : undefined}
            />
            {errors.password && (
              <p id="reg-password-err" className={styles.fieldError}>
                {errors.password}
              </p>
            )}
          </div>

          <div className={styles.row2}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reg-gender">
                Gender
              </label>
              <select
                id="reg-gender"
                name="gender"
                className={styles.select}
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                aria-invalid={Boolean(errors.gender)}
                aria-describedby={errors.gender ? 'reg-gender-err' : undefined}
              >
                {GENDER_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
              {errors.gender && (
                <p id="reg-gender-err" className={styles.fieldError}>
                  {errors.gender}
                </p>
              )}
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="reg-nationality">
                Nationality
              </label>
              <select
                id="reg-nationality"
                name="nationalityCode"
                className={styles.select}
                value={nationalityCode}
                onChange={(e) => setNationalityCode(e.target.value)}
                aria-invalid={Boolean(errors.nationalityCode)}
                aria-describedby={errors.nationalityCode ? 'reg-nat-err' : undefined}
              >
                {NATIONALITY_OPTIONS.map((opt) => (
                  <option key={opt.code} value={opt.code}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {errors.nationalityCode && (
                <p id="reg-nat-err" className={styles.fieldError}>
                  {errors.nationalityCode}
                </p>
              )}
            </div>
          </div>

          <button
            type="submit"
            className={styles.submitBtn}
            disabled={submitting}
          >
            {submitting
              ? inviteCode
                ? 'Creating account & joining pod...'
                : 'Creating account...'
              : inviteCode
                ? 'Create account & join invited pod'
                : 'Create account and open dashboard'}
          </button>
        </form>

        <p className={styles.switchLine}>
          <span>Already verified?</span>
          <Link href={loginHref} className={styles.inlineLink}>
            Sign in to your account
          </Link>
        </p>
      </div>
    </div>
  );
}

function TopLoginLink() {
  const searchParams = useSearchParams();
  const nextParams = new URLSearchParams();
  const inviteCode = extractInviteCode(searchParams.get('invite') || '');
  if (inviteCode) nextParams.set('invite', inviteCode);
  if (searchParams.get('fresh') === '1') nextParams.set('fresh', '1');
  const qs = nextParams.toString();
  return (
    <Link href={`/login${qs ? `?${qs}` : ''}`} className={styles.ghostLink}>
      Sign in
    </Link>
  );
}

export default function RegisterPage() {
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
                <Link href="/login" className={styles.ghostLink}>
                  Sign in
                </Link>
              }
            >
              <TopLoginLink />
            </Suspense>
          </div>
        </div>
      </header>
      <main className={styles.main}>
        <Suspense fallback={<p>Loading registration form...</p>}>
          <RegisterFormContent />
        </Suspense>
      </main>
    </div>
  );
}

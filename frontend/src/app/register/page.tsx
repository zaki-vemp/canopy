'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { colorVar, dealAlias } from '@/lib/pieces';
import { Door } from '@/components/door/Door';
import { useEnter } from '@/components/door/useEnter';
import ui from '@/components/pieces/ui.module.css';
import s from '../auth.module.css';

const GENDERS = ['Female', 'Male', 'Non-binary', 'Prefer not to say'];

const NATIONALITIES = [
  ['IN', 'India'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['DE', 'Germany'],
  ['CA', 'Canada'],
  ['AU', 'Australia'],
  ['JP', 'Japan'],
  ['SG', 'Singapore'],
  ['BR', 'Brazil'],
  ['FR', 'France'],
  ['NL', 'Netherlands'],
  ['SE', 'Sweden'],
  ['KR', 'South Korea'],
  ['AE', 'United Arab Emirates'],
  ['ZA', 'South Africa'],
  ['MX', 'Mexico'],
  ['ES', 'Spain'],
  ['IT', 'Italy'],
  ['PL', 'Poland'],
  ['XX', 'Somewhere else'],
];

function Kept({ name, typed }: { name: string; typed: string }) {
  return (
    <div className={s.kept}>
      <b>{name}</b>
      <span className={typed ? s.dots : undefined}>
        {typed ? '•'.repeat(Math.min(typed.length, 14)) : 'Account only'}
      </span>
    </div>
  );
}

function SignUp() {
  const { enter, invite, tabOnly, withQuery } = useEnter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [gender, setGender] = useState('Prefer not to say');
  const [nationalityCode, setNationalityCode] = useState('US');
  const [alias, setAlias] = useState('Jade Otter');
  const [errors, setErrors] = useState<{ fullName?: string; email?: string; password?: string }>({});
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem('');
    const next = {
      fullName: fullName.trim() ? undefined : 'Type your name.',
      email: email.includes('@') ? undefined : 'Type an email with an @ in it.',
      password: password.length >= 6 ? undefined : 'Use six characters or more.',
    };
    setErrors(next);
    if (next.fullName || next.email || next.password) return;
    setBusy(true);
    try {
      await enter('/api/auth/register', {
        email: email.trim(),
        password,
        fullName: fullName.trim(),
        gender,
        nationalityCode,
      });
    } catch (err) {
      setProblem(
        err instanceof ApiError ? err.message : 'Canopy did not answer. Check your connection and try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Door
      action={
        <Link className={`${ui.btn} ${ui.small}`} style={{ background: 'var(--sheet)' }} href={withQuery('/login')}>
          Sign in
        </Link>
      }
    >
      <main className={s.two}>
        <section className={s.keep} aria-label="What a room sees">
          <Kept name="Full name" typed={fullName} />
          <Kept name="Email" typed={email} />
          <Kept name="Gender" typed="" />
          <Kept name="Nationality" typed="" />
          <button
            type="button"
            className={s.dealt}
            style={colorVar(alias)}
            onClick={() => setAlias(dealAlias())}
            aria-label={`${alias}. An example alias. Deal another`}
          >
            <b>{alias}</b>
            <span>This is all a room sees. Press to deal another.</span>
          </button>
        </section>

        <section className={s.sheet}>
          <div className={s.inner}>
            <div>
              <h1>Make an account</h1>
              <p className={s.lead}>
                {invite
                  ? 'Then straight into the room you were invited to, under a fresh alias.'
                  : 'The dark blocks stay in your account. Every room you join deals you a new coloured one.'}
              </p>
            </div>
            {problem && (
              <p className={ui.alert} role="alert">
                {problem}
              </p>
            )}
            <form className={s.form} onSubmit={submit} noValidate>
              <label className={ui.field}>
                <span>Full name</span>
                <input
                  className={ui.input}
                  name="fullName"
                  autoComplete="name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  aria-invalid={Boolean(errors.fullName)}
                  aria-describedby="name-error"
                />
                <span id="name-error" className={s.error} hidden={!errors.fullName}>
                  {errors.fullName}
                </span>
              </label>
              <label className={ui.field}>
                <span>Email</span>
                <input
                  className={ui.input}
                  type="email"
                  name="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={Boolean(errors.email)}
                  aria-describedby="email-error"
                />
                <span id="email-error" className={s.error} hidden={!errors.email}>
                  {errors.email}
                </span>
              </label>
              <label className={ui.field}>
                <span>Password</span>
                <input
                  className={ui.input}
                  type="password"
                  name="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={Boolean(errors.password)}
                  aria-describedby="password-error"
                />
                <span id="password-error" className={s.error} hidden={!errors.password}>
                  {errors.password}
                </span>
              </label>
              <div className={s.pair}>
                <label className={ui.field}>
                  <span>Gender</span>
                  <select className={ui.input} name="gender" value={gender} onChange={(e) => setGender(e.target.value)}>
                    {GENDERS.map((g) => (
                      <option key={g}>{g}</option>
                    ))}
                  </select>
                </label>
                <label className={ui.field}>
                  <span>Nationality</span>
                  <select
                    className={ui.input}
                    name="nationalityCode"
                    value={nationalityCode}
                    onChange={(e) => setNationalityCode(e.target.value)}
                  >
                    {NATIONALITIES.map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button type="submit" className={`${ui.btn} ${ui.big} ${ui.blue}`} disabled={busy}>
                {busy ? 'Making it' : invite ? 'Make it and join' : 'Make an account'}
              </button>
            </form>
            <p className={s.swap}>
              Got one? <Link href={withQuery('/login')}>Sign in</Link>
            </p>
            {tabOnly && <p className={ui.hint}>This account stays signed in to this tab only.</p>}
          </div>
        </section>
      </main>
    </Door>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <SignUp />
    </Suspense>
  );
}

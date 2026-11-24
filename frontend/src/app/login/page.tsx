'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { Door } from '@/components/door/Door';
import { useEnter } from '@/components/door/useEnter';
import ui from '@/components/pieces/ui.module.css';
import s from '../auth.module.css';

const LETTERS = ['cobalt', 'amber', 'slate', 'coral', 'jade', ''];

function SignIn() {
  const { enter, invite, tabOnly, withQuery } = useEnter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem('');
    const next = {
      email: email.includes('@') ? undefined : 'Type the email you signed up with.',
      password: password ? undefined : 'Type your password.',
    };
    setErrors(next);
    if (next.email || next.password) return;
    setBusy(true);
    try {
      await enter('/api/auth/login', { email: email.trim(), password });
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
        <Link className={`${ui.btn} ${ui.small}`} style={{ background: 'var(--sheet)' }} href={withQuery('/register')}>
          Make an account
        </Link>
      }
    >
      <main className={s.two}>
        <a className={s.letters} href="/" aria-label="Canopy home">
          {[...'Canopy'].map((letter, i) => (
            <span key={i} aria-hidden="true" style={LETTERS[i] ? ({ '--c': `var(--c-${LETTERS[i]})` } as React.CSSProperties) : undefined}>
              {letter}
            </span>
          ))}
        </a>
        <section className={s.sheet}>
          <div className={s.inner}>
            <div>
              <h1>Sign in</h1>
              <p className={s.lead}>
                {invite
                  ? 'Then straight into the room you were invited to.'
                  : 'Your rooms, votes and private chats are where you left them.'}
              </p>
            </div>
            {problem && (
              <p className={ui.alert} role="alert">
                {problem}
              </p>
            )}
            <form className={s.form} onSubmit={submit} noValidate>
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
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={Boolean(errors.password)}
                  aria-describedby="password-error"
                />
                <span id="password-error" className={s.error} hidden={!errors.password}>
                  {errors.password}
                </span>
              </label>
              <button type="submit" className={`${ui.btn} ${ui.big} ${ui.blue}`} disabled={busy}>
                {busy ? 'Signing in' : invite ? 'Sign in and join' : 'Sign in'}
              </button>
            </form>
            <p className={s.swap}>
              New here? <Link href={withQuery('/register')}>Make an account</Link>
            </p>
            {tabOnly && <p className={ui.hint}>This sign-in stays in this tab only.</p>}
          </div>
        </section>
      </main>
    </Door>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}

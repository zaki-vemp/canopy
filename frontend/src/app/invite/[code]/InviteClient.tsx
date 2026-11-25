'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
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
import { colorVar } from '@/lib/pieces';
import { activePodIdAtom } from '@/state/workspaceAtoms';
import { setPods } from '@/state/roomActions';
import { Door } from '@/components/door/Door';
import { SeatDots } from '@/components/pieces/Piece';
import {
  extractInviteCode,
  type AcceptInviteResponse,
  type MatchRequest,
  type PodDetail,
  type PodInviteDto,
} from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import s from '../../auth.module.css';

async function fetchInvite(code: string): Promise<PodInviteDto> {
  const res = await fetch(`${API_BASE}/api/invites/${encodeURIComponent(code)}`, {
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      body?.error || body?.message || 'That invite could not be opened.'
    );
  }
  return ((await res.json()) as { invite: PodInviteDto }).invite;
}

function InviteContent() {
  // From the address, not useParams: the static build serves one file for every code.
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const setActivePodId = useSetAtom(activePodIdAtom);
  const code = extractInviteCode(pathname.split('/')[2] || '');
  const fresh = search.get('fresh') === '1';

  const [tabOnly, setTabOnly] = useState(fresh);
  const [signedIn, setSignedIn] = useState(false);
  const [invite, setInvite] = useState<PodInviteDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      if (!code) throw new Error('That is not an invite code.');
      setInvite(await fetchInvite(code));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'That invite could not be opened.');
    } finally {
      setLoading(false);
    }
  }, [code]);

  useEffect(() => {
    if (fresh) enableTabIsolatedMode();
    if (fresh || isTabIsolatedMode()) setTabOnly(true);
    setSignedIn(Boolean(getAuthToken()));
  }, [fresh]);

  useEffect(() => {
    load();
  }, [load]);

  const app = tabOnly ? '/app?fresh=1' : '/app';
  const qs = new URLSearchParams();
  if (code) qs.set('invite', code);
  if (tabOnly) qs.set('fresh', '1');

  const startFresh = () => {
    enableTabIsolatedMode();
    clearAuthToken();
    setTabOnly(true);
    setSignedIn(false);
    setProblem(null);
  };

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      router.push(app);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearAuthToken();
        setSignedIn(false);
        setProblem('You were signed out. Sign in and come straight back.');
      } else {
        setProblem(err instanceof Error ? err.message : 'That did not work. Try again.');
        load();
      }
    } finally {
      setBusy(false);
    }
  };

  const accept = () =>
    act(async () => {
      const res = await apiFetch<AcceptInviteResponse>(
        `/api/invites/${encodeURIComponent(code)}/accept`,
        { method: 'POST' }
      );
      setPods(queryClient, res.pods);
      setActivePodId(res.pod.podId);
    });

  const joinAnother = () => {
    if (!invite) return;
    if (!signedIn) {
      router.push(tabOnly ? '/register?fresh=1' : '/register');
      return;
    }
    act(async () => {
      const req: MatchRequest = {
        interest: invite.interestSlug,
        matchAll: false,
        allowAdditional: true,
      };
      const res = await apiFetch<{ matched: PodDetail[]; pods: PodDetail[] }>('/api/pods/match', {
        method: 'POST',
        body: JSON.stringify(req),
      });
      setPods(queryClient, res.pods);
      const target = res.matched[0] || res.pods[res.pods.length - 1];
      if (target) setActivePodId(target.podId);
    });
  };

  if (loading) {
    return (
      <main className={s.docSheet}>
        <div className={s.doc}>
          <p className={s.lead}>Opening the invite</p>
        </div>
      </main>
    );
  }

  if (!invite) {
    return (
      <main className={s.two}>
        <div className={s.room} style={{ '--c': 'var(--c-flint)' } as React.CSSProperties}>
          <p>This invite leads nowhere</p>
          <h2>No room</h2>
        </div>
        <section className={s.sheet}>
          <div className={s.inner}>
            <div>
              <h1>The link is wrong or gone</h1>
              <p className={s.lead}>{problem}</p>
            </div>
            <Link className={`${ui.btn} ${ui.big} ${ui.blue}`} href={signedIn ? app : '/register'}>
              {signedIn ? 'Open Canopy' : 'Find a room instead'}
            </Link>
          </div>
        </section>
      </main>
    );
  }

  const spent =
    !invite.canAccept && !invite.isRevoked && !invite.isExpired && !invite.isFull;
  const why = invite.isRevoked
    ? 'Someone in the room cancelled this link.'
    : invite.isExpired
      ? 'This link has run out.'
      : spent
        ? `This link let in ${invite.maxUses === 1 ? 'one person' : `${invite.maxUses} people`}, which was its limit.`
        : invite.isFull
          ? 'Every seat is taken.'
          : null;

  return (
    <main className={s.two}>
      <div className={s.room} style={colorVar(invite.podCode)}>
        <div>
          <p>{invite.invitedByAlias} invited you to</p>
          <h2>{invite.podTitle || invite.interestLabel}</h2>
        </div>
        <div className={s.seats}>
          <SeatDots
            taken={invite.memberCount}
            total={invite.maxMembers}
            columns={invite.maxMembers > 25 ? 17 : invite.maxMembers > 10 ? 13 : 10}
          />
          <p>
            {invite.memberCount} of {invite.maxMembers} seats taken
          </p>
        </div>
      </div>

      <section className={s.sheet}>
        <div className={s.inner}>
          <div>
            <h1>{why ?? 'There is a seat for you'}</h1>
            <p className={s.lead}>
              {why
                ? `There are other ${invite.interestLabel} rooms.`
                : `You come in as a colour and an animal. Nobody in there learns your name, not even ${invite.invitedByAlias}.`}
            </p>
          </div>
          {problem && (
            <p className={ui.alert} role="alert">
              {problem}
            </p>
          )}
          <div className={s.buttons}>
            {why ? (
              <>
                <button type="button" className={`${ui.btn} ${ui.big} ${ui.blue}`} disabled={busy} onClick={joinAnother}>
                  Join another {invite.interestLabel} room
                </button>
                {invite.isFull && signedIn && (
                  <button type="button" className={`${ui.btn} ${ui.big}`} disabled={busy} onClick={accept}>
                    I am already in it
                  </button>
                )}
              </>
            ) : signedIn ? (
              <>
                <button type="button" className={`${ui.btn} ${ui.big} ${ui.blue}`} disabled={busy} onClick={accept}>
                  {busy ? 'Taking your seat' : 'Take the seat'}
                </button>
                <button type="button" className={`${ui.btn} ${ui.big}`} onClick={startFresh}>
                  Join as a different account
                </button>
              </>
            ) : (
              <>
                <Link className={`${ui.btn} ${ui.big} ${ui.blue}`} href={`/register?${qs}`}>
                  Make an account and join
                </Link>
                <Link className={`${ui.btn} ${ui.big}`} href={`/login?${qs}`}>
                  Sign in and join
                </Link>
              </>
            )}
          </div>
          {tabOnly && <p className={ui.hint}>Whatever you do here stays in this tab.</p>}
        </div>
      </section>
    </main>
  );
}

export function InviteClient() {
  return (
    <Door
      action={
        <Link className={`${ui.btn} ${ui.small}`} style={{ background: 'var(--sheet)' }} href="/app">
          Open Canopy
        </Link>
      }
    >
      <Suspense>
        <InviteContent />
      </Suspense>
    </Door>
  );
}

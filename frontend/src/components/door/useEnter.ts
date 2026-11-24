'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useSetAtom } from 'jotai';
import { apiFetch, enableTabIsolatedMode, isTabIsolatedMode, setAuthToken } from '@/lib/api';
import { authRevisionAtom } from '@/state/authAtoms';
import { activePodIdAtom } from '@/state/workspaceAtoms';
import { setPods } from '@/state/roomActions';
import { extractInviteCode, type AcceptInviteResponse } from '@/types/canopy';

// What sign in and sign up share: the ?fresh=1 tab session, the ?invite= code
// that travels with you, and where you land afterwards.
export function useEnter() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const bumpRevision = useSetAtom(authRevisionAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const fresh = params.get('fresh') === '1';
  const invite = extractInviteCode(params.get('invite') || '');
  const [tabOnly, setTabOnly] = useState(fresh);

  useEffect(() => {
    if (fresh) enableTabIsolatedMode();
    if (fresh || isTabIsolatedMode()) setTabOnly(true);
  }, [fresh]);

  const enter = async (path: '/api/auth/login' | '/api/auth/register', body: object) => {
    const here = fresh || isTabIsolatedMode();
    const res = await apiFetch<{ token: string }>(`${path}${here ? '?tabOnly=true' : ''}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    setAuthToken(res.token, here);
    queryClient.clear();
    bumpRevision((r) => r + 1);
    const qs = here ? '?fresh=1' : '';
    if (!invite) {
      setActivePodId(null);
      router.push(`/app${qs}`);
      return;
    }
    try {
      const accepted = await apiFetch<AcceptInviteResponse>(
        `/api/invites/${encodeURIComponent(invite)}/accept`,
        { method: 'POST' }
      );
      setPods(queryClient, accepted.pods);
      setActivePodId(accepted.pod.podId);
      router.push(`/app${qs}`);
    } catch {
      router.push(`/invite/${encodeURIComponent(invite)}${qs}`);
    }
  };

  const qs = new URLSearchParams();
  if (invite) qs.set('invite', invite);
  if (tabOnly) qs.set('fresh', '1');
  const withQuery = (path: string) => `${path}${qs.size ? `?${qs}` : ''}`;

  return { enter, invite, tabOnly, withQuery };
}

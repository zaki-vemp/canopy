import { atom } from 'jotai';
import { atomWithQuery } from 'jotai-tanstack-query';
import { ApiError, apiFetch, clearAuthToken } from '@/lib/api';
import type { SelfUser } from '@/types/canopy';

export const authBootstrapReadyAtom = atom<boolean>(false);
export const authRevisionAtom = atom<number>(0);

export const selfUserQueryAtom = atomWithQuery<{ user: SelfUser }, ApiError>(
  (get) => ({
    queryKey: ['auth', 'me', get(authRevisionAtom)],
    queryFn: () => apiFetch<{ user: SelfUser }>('/api/auth/me'),
    enabled: get(authBootstrapReadyAtom),
    retry: false,
    staleTime: 30_000,
  })
);

export const selfUserAtom = atom<SelfUser | null>(
  (get) => get(selfUserQueryAtom).data?.user ?? null
);

export async function performLogout(): Promise<void> {
  try {
    await apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  } catch {
    // clear local session regardless of backend network status
  }
  clearAuthToken();
}

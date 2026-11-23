import { atom } from 'jotai';
import { atomFamily, atomWithStorage } from 'jotai/utils';
import { atomWithQuery } from 'jotai-tanstack-query';
import { ApiError, apiFetch } from '@/lib/api';
import { selfUserAtom } from '@/state/authAtoms';
import type {
  PodDetail,
  PodMember,
  RichMessage,
  RightPanelMode,
  VoicePeer,
} from '@/types/canopy';

export interface PodPresenceSnapshot {
  selfPeerId: string;
  onlinePeerIds: string[];
  members: PodMember[];
}

export const activePodIdAtom = atom<string | null>(null);

export const activeChannelIdMapAtom = atomWithStorage<Record<string, string>>(
  'canopy_active_channels',
  {}
);

export const rightPanelAtom = atom<RightPanelMode>('members');

const baseThreadMessageIdAtom = atom<number | null>(null);

export const activeThreadMessageIdAtom = atom(
  (get) => get(baseThreadMessageIdAtom),
  (get, set, messageId: number | null) => {
    set(baseThreadMessageIdAtom, messageId);
    if (messageId !== null) {
      set(rightPanelAtom, 'thread');
    } else if (get(rightPanelAtom) === 'thread') {
      const isMobile =
        typeof window !== 'undefined' && window.innerWidth <= 900;
      set(rightPanelAtom, isMobile ? null : 'members');
    }
  }
);

export type InterestModalTab = 'pods' | 'match' | 'publicized' | 'custom';

export const commandModalOpenAtom = atom<boolean>(false);
export const interestModalOpenAtom = atom<boolean>(false);
export const interestModalTabAtom = atom<InterestModalTab>('match');
export const inviteModalPodIdAtom = atom<string | null>(null);
export const adminSettingsPodIdAtom = atom<string | null>(null);
export const accountDrawerOpenAtom = atom<boolean>(false);
export const mobileNavOpenAtom = atom<boolean>(false);
export const mobileVoiceSheetOpenAtom = atom<boolean>(false);
export const proposeSheetOpenAtom = atom<boolean>(false);
export const kickedNoticeAtom = atom<string | null>(null);
export const highlightedMessageIdAtom = atom<number | null>(null);

export const draftByChannelAtom = atomFamily((_channelId: string) =>
  atom<string>('')
);

export const quoteTargetByChannelAtom = atomFamily((_channelId: string) =>
  atom<RichMessage | null>(null)
);

export const presenceByPodAtom = atom<Record<string, PodPresenceSnapshot>>({});

export const voiceRosterByPodAtom = atom<
  Record<string, Record<string, VoicePeer[]>>
>({});

export const typingByChannelAtom = atom<Record<string, string[]>>({});

export const unreadByChannelAtom = atom<Record<string, number>>({});

export const wsConnectedAtom = atom<boolean>(false);

export const podsQueryAtom = atomWithQuery<{ pods: PodDetail[] }, ApiError>(
  (get) => ({
    queryKey: ['pods'],
    queryFn: () => apiFetch<{ pods: PodDetail[] }>('/api/pods'),
    enabled: Boolean(get(selfUserAtom)),
    staleTime: 15_000,
  })
);

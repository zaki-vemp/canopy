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

// null = Pod Group Chat, "p_..." = 1:1 Private Chat with that member
export const activeDmPeerByPodAtom = atomWithStorage<
  Record<string, string | null>
>('canopy_active_dm_peer', {});

export const rightPanelAtom = atom<RightPanelMode>(null);

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

export const draftByConvoAtom = atomFamily((_convoKey: string) =>
  atom<string>('')
);

export const quoteTargetByConvoAtom = atomFamily((_convoKey: string) =>
  atom<RichMessage | null>(null)
);

export const presenceByPodAtom = atom<Record<string, PodPresenceSnapshot>>({});

export const voicePeersByPodAtom = atom<Record<string, VoicePeer[]>>({});

export const typingByConvoAtom = atom<Record<string, string[]>>({});

export const unreadByConvoAtom = atom<Record<string, number>>({});

// Keyed by conversationKey(podId, otherPeerId) -> peer's lastReadMessageId in that 1:1 DM
export const peerReadByConvoAtom = atom<Record<string, number>>({});

export const wsConnectedAtom = atom<boolean>(false);

export const podsQueryAtom = atomWithQuery<{ pods: PodDetail[] }, ApiError>(
  (get) => ({
    queryKey: ['pods'],
    queryFn: () => apiFetch<{ pods: PodDetail[] }>('/api/pods'),
    enabled: Boolean(get(selfUserAtom)),
    staleTime: 15_000,
  })
);

import { atom } from 'jotai';
import type {
  MobileTabKey,
  PodMember,
  RichMessage,
  SelfUser,
  VoicePeer,
} from '../types/canopy';
import { getDefaultApiBaseUrl } from '../api/client';

export interface PodPresenceState {
  selfPeerId: string;
  onlinePeerIds: string[];
  members: PodMember[];
}

export interface ActiveVoiceSession {
  podId: string;
  voiceChannelId: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  micMode: 'live' | 'listen-synth';
}

export const authTokenAtom = atom<string | null>(null);
export const authUserAtom = atom<SelfUser | null>(null);
export const apiBaseUrlAtom = atom<string>(getDefaultApiBaseUrl());

export const activeTabAtom = atom<MobileTabKey>('pods');
export const activePodIdAtom = atom<string | null>(null);
export const activeChannelByPodAtom = atom<Record<string, string>>({});
export const activeThreadParentAtom = atom<RichMessage | null>(null);

export const wsConnectedAtom = atom<boolean>(false);
export const podPresenceByPodAtom = atom<Record<string, PodPresenceState>>({});
export const typingByChannelAtom = atom<Record<string, string[]>>({});
export const voiceRosterByPodAtom = atom<
  Record<string, Record<string, VoicePeer[]>>
>({});
export const activeVoiceSessionAtom = atom<ActiveVoiceSession | null>(null);
export const lastWebRtcSignalAtom = atom<{
  voiceChannelId: string;
  fromPeerId: string;
  fromAlias: string;
  receivedAt: number;
} | null>(null);

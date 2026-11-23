import { atom } from 'jotai';
import type {
  MemberDto,
  MobileTabKey,
  SelfUser,
  VoicePeerDto,
} from '../types/canopy';
import { getDefaultApiBaseUrl } from '../api/client';

export interface PodPresenceState {
  selfPeerId: string;
  onlinePeerIds: string[];
  members: MemberDto[];
}

export interface ActiveVoiceSession {
  podId: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  micMode: 'live' | 'listen-synth';
}

export interface ActiveDmCallSession {
  podId: string;
  peerId: string;
  peerAlias: string;
  peerColor: string;
  peerOnline: boolean;
  phase: 'ringing' | 'incoming' | 'connected';
  muted: boolean;
  speaking: boolean;
  peerMuted: boolean;
  peerSpeaking: boolean;
}

export function dmConvoKey(podId: string, peerId: string | null): string {
  return peerId ? `${podId}:dm:${peerId}` : `${podId}:group`;
}

export const authTokenAtom = atom<string | null>(null);
export const authUserAtom = atom<SelfUser | null>(null);
export const apiBaseUrlAtom = atom<string>(getDefaultApiBaseUrl());

export const activeTabAtom = atom<MobileTabKey>('pods');
export const activePodIdAtom = atom<string | null>(null);
// null = Pod Group Chat; "p_..." = 1:1 Private Chat with that pod member
export const activeDmPeerByPodAtom = atom<Record<string, string | null>>({});
export const unreadGroupByPodAtom = atom<Record<string, number>>({});
export const unreadDmByPodPeerAtom = atom<Record<string, number>>({});
export const peerLastReadByPodPeerAtom = atom<Record<string, number>>({});

export const wsConnectedAtom = atom<boolean>(false);
export const podPresenceByPodAtom = atom<Record<string, PodPresenceState>>({});
export const typingByConvoAtom = atom<Record<string, string[]>>({});
export const voicePeersByPodAtom = atom<Record<string, VoicePeerDto[]>>({});
export const activeVoiceSessionAtom = atom<ActiveVoiceSession | null>(null);
export const activeDmCallAtom = atom<ActiveDmCallSession | null>(null);
export const dmCallNoticeAtom = atom<string | null>(null);
export const lastWebRtcSignalAtom = atom<{
  fromPeerId: string;
  fromAlias: string;
  scope?: 'GROUP' | 'DM';
  receivedAt: number;
} | null>(null);

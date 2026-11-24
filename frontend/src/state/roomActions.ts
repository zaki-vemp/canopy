'use client';

import { useCallback } from 'react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { apiFetch } from '@/lib/api';
import {
  activeDmPeerByPodAtom,
  activePodIdAtom,
  interestModalOpenAtom,
  interestModalTabAtom,
  mobileNavOpenAtom,
  presenceByPodAtom,
  rightPanelAtom,
  unreadByConvoAtom,
  voicePeersByPodAtom,
  type InterestModalTab,
} from '@/state/workspaceAtoms';
import { useVoiceActions, voiceSessionAtom } from '@/state/voiceEngine';
import { markConversationReadInCaches } from '@/state/wsPodClient';
import {
  conversationKey,
  type LeavePodRequest,
  type PodDetail,
  type PodMember,
  type VoicePeer,
} from '@/types/canopy';

export const PHONE = '(max-width: 819px)';

export function isPhone(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(PHONE).matches;
}

export function roomName(pod: PodDetail): string {
  return pod.title || pod.interestLabel;
}

export function setPods(queryClient: QueryClient, pods: PodDetail[]): void {
  queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], { pods });
  queryClient.invalidateQueries({ queryKey: ['interests'] });
}

export function mergePod(queryClient: QueryClient, pod: PodDetail): void {
  queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) =>
    old
      ? {
          pods: old.pods.map((p) =>
            p.podId === pod.podId
              ? {
                  ...p,
                  ...pod,
                  dmConversations: pod.dmConversations?.length
                    ? pod.dmConversations
                    : p.dmConversations,
                }
              : p
          ),
        }
      : { pods: [pod] }
  );
}

export function useMergeRoster() {
  const queryClient = useQueryClient();
  const setPresence = useSetAtom(presenceByPodAtom);
  return useCallback(
    (pod: PodDetail) => {
      mergePod(queryClient, pod);
      setPresence((prev) => {
        const snap = prev[pod.podId];
        if (!snap) return prev;
        return {
          ...prev,
          [pod.podId]: {
            ...snap,
            members: pod.members,
            onlinePeerIds: pod.members.filter((m) => m.online).map((m) => m.peerId),
          },
        };
      });
    },
    [queryClient, setPresence]
  );
}

export function useMembers(pod: PodDetail | null): PodMember[] {
  const presence = useAtomValue(presenceByPodAtom);
  if (!pod) return [];
  return presence[pod.podId]?.members ?? pod.members;
}

// peerId null is the group chat, "p_..." is the private chat with that member.
export function useOpenConversation() {
  const queryClient = useQueryClient();
  const setActivePodId = useSetAtom(activePodIdAtom);
  const setDmPeers = useSetAtom(activeDmPeerByPodAtom);
  const setUnread = useSetAtom(unreadByConvoAtom);
  const setNavOpen = useSetAtom(mobileNavOpenAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);

  return useCallback(
    (podId: string, peerId: string | null) => {
      setActivePodId(podId);
      setDmPeers((prev) => ({ ...prev, [podId]: peerId }));
      const key = conversationKey(podId, peerId);
      setUnread((prev) => (prev[key] === 0 ? prev : { ...prev, [key]: 0 }));
      markConversationReadInCaches(queryClient, podId, peerId);
      setNavOpen(false);
      if (isPhone()) setRightPanel(null);
    },
    [queryClient, setActivePodId, setDmPeers, setNavOpen, setRightPanel, setUnread]
  );
}

export function useOpenRooms() {
  const setOpen = useSetAtom(interestModalOpenAtom);
  const setTab = useSetAtom(interestModalTabAtom);
  return useCallback(
    (tab: InterestModalTab) => {
      setTab(tab);
      setOpen(true);
    },
    [setOpen, setTab]
  );
}

export interface LeaveRoomInput extends LeavePodRequest {
  podId: string;
}

export function useLeaveRoom(pods: PodDetail[]) {
  const queryClient = useQueryClient();
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const openRooms = useOpenRooms();
  const { session, dmSession, leaveVoice, endDmCall } = useVoiceActions();

  return useMutation({
    mutationFn: ({ podId, ...body }: LeaveRoomInput) => {
      if (session.podId === podId) leaveVoice();
      if (dmSession.podId === podId) endDmCall();
      return apiFetch<{ leftPodId: string; newPod: PodDetail | null }>(
        `/api/pods/${podId}/leave`,
        { method: 'POST', body: JSON.stringify(body) }
      );
    },
    onSuccess: (res) => {
      const rest = pods.filter((p) => p.podId !== res.leftPodId);
      const next = res.newPod ? [...rest, res.newPod] : rest;
      setPods(queryClient, next);
      if (res.newPod) {
        setActivePodId(res.newPod.podId);
      } else if (activePodId === res.leftPodId) {
        setActivePodId(next[0]?.podId ?? null);
      }
      if (next.length === 0) openRooms('match');
    },
  });
}

// Everyone in a room's call. Your own seat is added the moment you are
// connected, before the server's roster comes back.
export function useRoomCall(pod: PodDetail | null): {
  inCall: boolean;
  peers: VoicePeer[];
} {
  const byPod = useAtomValue(voicePeersByPodAtom);
  const voice = useAtomValue(voiceSessionAtom);
  if (!pod) return { inCall: false, peers: [] };
  const inCall = voice.status !== 'idle' && voice.podId === pod.podId;
  const peers = byPod[pod.podId] ?? [];
  if (
    inCall &&
    voice.status === 'connected' &&
    !peers.some((p) => p.peerId === pod.myPeerId)
  ) {
    return {
      inCall,
      peers: [
        {
          peerId: pod.myPeerId,
          alias: pod.myAlias,
          color: pod.myColor,
          muted: voice.muted,
          deafened: voice.deafened,
          speaking: voice.selfSpeaking,
        },
        ...peers,
      ],
    };
  }
  return { inCall, peers };
}

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import {
  activeDmCallAtom,
  activePodIdAtom,
  activeVoiceSessionAtom,
  callLinksAtom,
  callNoticeAtom,
  podPresenceByPodAtom,
  speakerOnAtom,
  voicePeersByPodAtom,
} from '../state/atoms';
import type { PodDetailDto, WsOutboundFrame } from '../types/canopy';
import { CallEngine } from './engine';
import { loadKit } from './kit';
import { onSocketOpen, onWebRtcSignal } from './signals';

export interface CallPeer {
  peerId: string;
  alias: string;
  color: string;
  online: boolean;
}

export interface Calls {
  joinRoomCall: (pod: PodDetailDto) => Promise<void>;
  startPrivateCall: (pod: PodDetailDto, peer: CallPeer) => Promise<void>;
  answerPrivateCall: () => Promise<void>;
  declinePrivateCall: () => void;
  hangUp: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  toggleSpeaker: () => void;
}

const SPEAKING_LEVEL = 0.02;
const NO_KIT = 'Calls need the Canopy app itself. They do not run in Expo Go or this browser.';
const NO_MIC = 'You can hear the others. Turn the microphone on in settings to talk.';

/** Owns the one call on this phone. Use it once, at the top of the signed-in app. */
export function useCalls(sendFrame: (frame: WsOutboundFrame) => boolean): Calls {
  const store = useStore();
  const queryClient = useQueryClient();
  const activePodId = useAtomValue(activePodIdAtom);
  const session = useAtomValue(activeVoiceSessionAtom);
  const dmCall = useAtomValue(activeDmCallAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);

  const sendRef = useRef(sendFrame);
  sendRef.current = sendFrame;

  const engineRef = useRef<CallEngine | null>(null);
  const engine = useCallback((): CallEngine | null => {
    if (!engineRef.current) {
      const kit = loadKit();
      if (!kit) {
        store.set(callNoticeAtom, NO_KIT);
        return null;
      }
      engineRef.current = new CallEngine(
        kit,
        (frame) => sendRef.current(frame),
        (links) => store.set(callLinksAtom, links)
      );
    }
    return engineRef.current;
  }, [store]);

  const selfPeerIdIn = useCallback(
    (podId: string): string =>
      store.get(podPresenceByPodAtom)[podId]?.selfPeerId ??
      queryClient
        .getQueryData<{ pods: PodDetailDto[] }>(['pods'])
        ?.pods.find((p) => p.podId === podId)?.myPeerId ??
      '',
    [queryClient, store]
  );

  const hangUp = useCallback(() => {
    const call = store.get(activeDmCallAtom);
    if (store.get(activeVoiceSessionAtom)) sendRef.current({ type: 'voice_leave' });
    if (call) sendRef.current({ type: 'dm_call_end', peerId: call.peerId });
    engineRef.current?.close();
    store.set(activeVoiceSessionAtom, null);
    store.set(activeDmCallAtom, null);
    store.set(speakerOnAtom, true);
  }, [store]);

  const calls = useMemo<Calls>(
    () => ({
      hangUp,

      joinRoomCall: async (pod) => {
        const eng = engine();
        if (!eng) return;
        hangUp();
        store.set(callNoticeAtom, null);
        store.set(activeVoiceSessionAtom, {
          podId: pod.podId,
          status: 'connecting',
          muted: false,
          deafened: false,
          speaking: false,
          micMode: 'live',
        });
        const micMode = await eng.open('GROUP', selfPeerIdIn(pod.podId) || pod.myPeerId);
        if (!micMode) return;
        const muted = micMode === 'listen';
        // The server relays call signals only for people already in the call,
        // so the join goes out before the first offer. If the socket is down,
        // the socket-open listener below joins instead.
        sendRef.current({ type: 'voice_join', muted, deafened: false });
        store.set(activeVoiceSessionAtom, {
          podId: pod.podId,
          status: 'connected',
          muted,
          deafened: false,
          speaking: false,
          micMode,
        });
        if (muted) store.set(callNoticeAtom, NO_MIC);
      },

      startPrivateCall: async (pod, peer) => {
        const eng = engine();
        if (!eng) return;
        hangUp();
        store.set(callNoticeAtom, null);
        store.set(activeDmCallAtom, {
          podId: pod.podId,
          peerId: peer.peerId,
          peerAlias: peer.alias,
          peerColor: peer.color,
          peerOnline: peer.online,
          phase: 'ringing',
          muted: false,
          speaking: false,
          peerMuted: false,
          peerSpeaking: false,
        });
        const micMode = await eng.open('DM', selfPeerIdIn(pod.podId) || pod.myPeerId);
        if (!micMode) return;
        if (micMode === 'listen') store.set(callNoticeAtom, NO_MIC);
        sendRef.current({ type: 'dm_call_ring', targetPeerId: peer.peerId });
      },

      answerPrivateCall: async () => {
        const call = store.get(activeDmCallAtom);
        if (!call || call.phase !== 'incoming') return;
        const eng = engine();
        if (!eng) {
          sendRef.current({ type: 'dm_call_decline', callerPeerId: call.peerId });
          store.set(activeDmCallAtom, null);
          return;
        }
        if (store.get(activeVoiceSessionAtom)) {
          sendRef.current({ type: 'voice_leave' });
          store.set(activeVoiceSessionAtom, null);
        }
        store.set(activeDmCallAtom, { ...call, phase: 'answering' });
        const micMode = await eng.open('DM', selfPeerIdIn(call.podId));
        if (!micMode) return;
        if (micMode === 'listen') store.set(callNoticeAtom, NO_MIC);
        sendRef.current({ type: 'dm_call_accept', callerPeerId: call.peerId });
      },

      declinePrivateCall: () => {
        const call = store.get(activeDmCallAtom);
        if (!call) return;
        sendRef.current({ type: 'dm_call_decline', callerPeerId: call.peerId });
        store.set(activeDmCallAtom, null);
      },

      toggleMute: () => {
        const room = store.get(activeVoiceSessionAtom);
        if (room) {
          if (room.micMode === 'listen') {
            store.set(callNoticeAtom, NO_MIC);
            return;
          }
          const muted = !room.muted;
          // Talking again means you want to hear too.
          const deafened = muted ? room.deafened : false;
          engineRef.current?.setMuted(muted);
          engineRef.current?.setDeafened(deafened);
          store.set(activeVoiceSessionAtom, { ...room, muted, deafened, speaking: false });
          sendRef.current({ type: 'voice_state', muted, deafened, speaking: false });
          return;
        }
        const call = store.get(activeDmCallAtom);
        if (call?.phase === 'connected') {
          const muted = !call.muted;
          engineRef.current?.setMuted(muted);
          store.set(activeDmCallAtom, { ...call, muted, speaking: false });
          sendRef.current({ type: 'dm_call_state', peerId: call.peerId, muted, speaking: false });
        }
      },

      toggleDeafen: () => {
        const room = store.get(activeVoiceSessionAtom);
        if (!room) return;
        const deafened = !room.deafened;
        const muted = deafened ? true : room.micMode === 'listen';
        engineRef.current?.setDeafened(deafened);
        engineRef.current?.setMuted(muted);
        store.set(activeVoiceSessionAtom, { ...room, muted, deafened, speaking: false });
        sendRef.current({ type: 'voice_state', muted, deafened, speaking: false });
      },

      toggleSpeaker: () => {
        const on = !store.get(speakerOnAtom);
        engineRef.current?.setSpeaker(on);
        store.set(speakerOnAtom, on);
      },
    }),
    [engine, hangUp, selfPeerIdIn, store]
  );

  // Everyone in the room call gets one connection.
  const roomPodId = session?.status === 'connected' ? session.podId : null;
  const roster = roomPodId ? voicePeersByPod[roomPodId] : undefined;
  useEffect(() => {
    if (roomPodId && roster) engineRef.current?.sync(roster.map((p) => p.peerId));
  }, [roomPodId, roster]);

  const dmPeerId = dmCall?.phase === 'connected' ? dmCall.peerId : null;
  useEffect(() => {
    if (dmPeerId && engineRef.current?.scope === 'DM') engineRef.current.sync([dmPeerId]);
  }, [dmPeerId]);

  // The other side hung up, or we were removed from the room.
  const inRoomCall = session !== null;
  const inDmCall = dmCall !== null && dmCall.phase !== 'incoming';
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    if ((eng.scope === 'GROUP' && !inRoomCall) || (eng.scope === 'DM' && !inDmCall)) {
      eng.close();
      store.set(speakerOnAtom, true);
    }
  }, [inRoomCall, inDmCall, store]);

  useEffect(
    () =>
      onWebRtcSignal((frame) => {
        const scope = frame.scope === 'DM' ? 'DM' : 'GROUP';
        if (scope === 'DM' && store.get(activeDmCallAtom)?.peerId !== frame.fromPeerId) return;
        engineRef.current?.receive(frame.fromPeerId, scope, frame.signal);
      }),
    [store]
  );

  // The socket came back. Leave first: if the server still holds the old
  // connection, the others would keep talking into it.
  useEffect(
    () =>
      onSocketOpen((podId) => {
        const room = store.get(activeVoiceSessionAtom);
        if (room?.podId === podId && room.status === 'connected') {
          engineRef.current?.resetPeers();
          // 'connecting' holds back new offers: the server may still list our old
          // connection, and it drops offers that reach it before the join.
          store.set(activeVoiceSessionAtom, { ...room, status: 'connecting', speaking: false });
          sendRef.current({ type: 'voice_leave' });
          setTimeout(() => {
            const now = store.get(activeVoiceSessionAtom);
            if (now?.podId !== podId) return;
            sendRef.current({
              type: 'voice_join',
              muted: now.muted,
              deafened: now.deafened,
            });
            store.set(activeVoiceSessionAtom, { ...now, status: 'connected' });
          }, 500);
        }
        const call = store.get(activeDmCallAtom);
        if (call?.podId === podId) {
          // The server ends a private call when either socket drops.
          store.set(activeDmCallAtom, null);
          store.set(callNoticeAtom, `The call with ${call.peerAlias} dropped.`);
        }
      }),
    [store]
  );

  // ponytail: one socket, so one room at a time; moving to another room ends the call.
  useEffect(() => {
    const room = store.get(activeVoiceSessionAtom);
    const call = store.get(activeDmCallAtom);
    if (
      (room && activePodId && room.podId !== activePodId) ||
      (call && activePodId && call.podId !== activePodId)
    ) {
      hangUp();
    }
  }, [activePodId, hangUp, store]);

  // Light up our piece while we talk.
  const listening = roomPodId !== null || dmPeerId !== null;
  useEffect(() => {
    if (!listening) return;
    let busy = false;
    let quiet = 0;
    const timer = setInterval(async () => {
      const eng = engineRef.current;
      if (!eng || busy) return;
      busy = true;
      const level = await eng.micLevel().catch(() => 0);
      busy = false;
      // Hold through the gaps between words.
      quiet = level > SPEAKING_LEVEL ? 0 : quiet + 1;
      const speaking = quiet < 3;
      const room = store.get(activeVoiceSessionAtom);
      const call = store.get(activeDmCallAtom);
      if (room?.status === 'connected' && room.speaking !== speaking) {
        store.set(activeVoiceSessionAtom, { ...room, speaking });
        sendRef.current({
          type: 'voice_state',
          muted: room.muted,
          deafened: room.deafened,
          speaking,
        });
      } else if (call?.phase === 'connected' && call.speaking !== speaking) {
        store.set(activeDmCallAtom, { ...call, speaking });
        sendRef.current({
          type: 'dm_call_state',
          peerId: call.peerId,
          muted: call.muted,
          speaking,
        });
      }
    }, 300);
    return () => clearInterval(timer);
  }, [listening, store]);

  const notice = useAtomValue(callNoticeAtom);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => store.set(callNoticeAtom, null), 6000);
    return () => clearTimeout(timer);
  }, [notice, store]);

  useEffect(
    () => () => {
      engineRef.current?.close();
    },
    []
  );

  return calls;
}

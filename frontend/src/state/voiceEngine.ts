'use client';

import { useCallback, useEffect } from 'react';
import { atom, useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import {
  activePodIdAtom,
  podsQueryAtom,
  presenceByPodAtom,
  voicePeersByPodAtom,
} from '@/state/workspaceAtoms';
import {
  sendPodWsFrame,
  subscribeDmCallEvents,
  subscribeWebRtcSignals,
  subscribeWsOpen,
} from '@/state/wsPodClient';
import type { VoiceCallScope, VoicePeer } from '@/types/canopy';

export interface VoiceSessionState {
  podId: string | null;
  podLabel: string;
  selfPeerId: string | null;
  status: 'idle' | 'connecting' | 'connected';
  usingFallbackSynth: boolean;
  fallbackBanner: string | null;
  testToneActive: boolean;
  muted: boolean;
  deafened: boolean;
  selfSpeaking: boolean;
}

const INITIAL_VOICE_STATE: VoiceSessionState = {
  podId: null,
  podLabel: '',
  selfPeerId: null,
  status: 'idle',
  usingFallbackSynth: false,
  fallbackBanner: null,
  testToneActive: false,
  muted: false,
  deafened: false,
  selfSpeaking: false,
};

export interface DmCallSessionState {
  podId: string | null;
  selfPeerId: string | null;
  peerId: string | null;
  peerAlias: string;
  peerColor: string;
  targetOnline: boolean;
  status: 'idle' | 'ringing' | 'connecting' | 'connected';
  connectedAtMs: number | null;
  usingFallbackSynth: boolean;
  fallbackBanner: string | null;
  testToneActive: boolean;
  muted: boolean;
  deafened: boolean;
  selfSpeaking: boolean;
  peerMuted: boolean;
  peerSpeaking: boolean;
}

export const INITIAL_DM_CALL_STATE: DmCallSessionState = {
  podId: null,
  selfPeerId: null,
  peerId: null,
  peerAlias: '',
  peerColor: '#1f6b3a',
  targetOnline: true,
  status: 'idle',
  connectedAtMs: null,
  usingFallbackSynth: false,
  fallbackBanner: null,
  testToneActive: false,
  muted: false,
  deafened: false,
  selfSpeaking: false,
  peerMuted: false,
  peerSpeaking: false,
};

export interface IncomingDmCallState {
  podId: string;
  fromPeerId: string;
  fromAlias: string;
  fromColor: string;
}

export const voiceSessionAtom = atom<VoiceSessionState>(INITIAL_VOICE_STATE);
export const dmCallSessionAtom = atom<DmCallSessionState>(INITIAL_DM_CALL_STATE);
export const incomingDmCallAtom = atom<IncomingDmCallState | null>(null);
export const dmCallNoticeAtom = atom<string | null>(null);

// Per-peer volume multiplier: 0.0 (0%) .. 1.5 (150%), default 1.0 (100%)
export const peerVolumeMapAtom = atom<Record<string, number>>({});

// Remote WebAudio AnalyserNode speaking flags keyed by peerId
export const remoteSpeakingMapAtom = atom<Record<string, boolean>>({});

interface PeerConnectionEntry {
  peerId: string;
  scope: VoiceCallScope;
  pc: RTCPeerConnection;
  pendingCandidates: RTCIceCandidateInit[];
  offerSent: boolean;
  audioEl: HTMLAudioElement | null;
  gainNode: GainNode | null;
  analyser: AnalyserNode | null;
  sourceNode: MediaStreamAudioSourceNode | null;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// ponytail: full P2P Opus mesh handles ~8-10 simultaneous speakers in a 25-member pod; switch to an SFU above ~12 active voice peers.
class VoiceMeshRuntime {
  audioCtx: AudioContext | null = null;
  hardwareStream: MediaStream | null = null;
  outgoingDest: MediaStreamAudioDestinationNode | null = null;
  outgoingInputGain: GainNode | null = null;
  localAnalyser: AnalyserNode | null = null;

  synthOscLow: OscillatorNode | null = null;
  synthOscHigh: OscillatorNode | null = null;
  synthEnvelopeGain: GainNode | null = null;
  synthMonitorGain: GainNode | null = null;
  synthCadenceTimer: ReturnType<typeof setInterval> | null = null;

  detectorTimer: ReturnType<typeof setInterval> | null = null;
  peers = new Map<string, PeerConnectionEntry>();
  audioContainer: HTMLDivElement | null = null;

  chimeCtx: AudioContext | null = null;
  chimeTimer: ReturnType<typeof setInterval> | null = null;

  ensureAudioContainer(): HTMLDivElement {
    if (this.audioContainer && document.body.contains(this.audioContainer)) {
      return this.audioContainer;
    }
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    el.style.position = 'fixed';
    el.style.width = '0';
    el.style.height = '0';
    el.style.overflow = 'hidden';
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
    this.audioContainer = el;
    return el;
  }

  stopIncomingChime(): void {
    if (this.chimeTimer) {
      clearInterval(this.chimeTimer);
      this.chimeTimer = null;
    }
    if (this.chimeCtx) {
      this.chimeCtx.close().catch(() => {});
      this.chimeCtx = null;
    }
  }

  startIncomingChime(): void {
    this.stopIncomingChime();
    if (typeof window === 'undefined') return;
    try {
      const ctx = createAudioContext();
      this.chimeCtx = ctx;
      const playPair = () => {
        if (!this.chimeCtx) return;
        this.chimeCtx.resume().catch(() => {});
        const now = this.chimeCtx.currentTime;
        const notes = [
          { freq: 523.25, start: now + 0.02, dur: 0.22 },
          { freq: 659.25, start: now + 0.26, dur: 0.3 },
        ];
        for (const n of notes) {
          const osc = this.chimeCtx.createOscillator();
          const gain = this.chimeCtx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(n.freq, n.start);
          gain.gain.setValueAtTime(0.0001, n.start);
          gain.gain.exponentialRampToValueAtTime(0.055, n.start + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.0001, n.start + n.dur);
          osc.connect(gain);
          gain.connect(this.chimeCtx.destination);
          osc.start(n.start);
          osc.stop(n.start + n.dur + 0.02);
        }
      };
      playPair();
      let rings = 1;
      this.chimeTimer = setInterval(() => {
        rings += 1;
        if (rings > 10) {
          this.stopIncomingChime();
          return;
        }
        playPair();
      }, 2600);
    } catch {
      // ignore WebAudio restrictions prior to user gesture
    }
  }

  closePeer(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    this.peers.delete(peerId);
    try {
      entry.sourceNode?.disconnect();
      entry.gainNode?.disconnect();
      entry.analyser?.disconnect();
    } catch {
      // ignore disconnect errors during teardown
    }
    if (entry.audioEl) {
      entry.audioEl.pause();
      entry.audioEl.srcObject = null;
      entry.audioEl.remove();
    }
    try {
      entry.pc.onicecandidate = null;
      entry.pc.ontrack = null;
      entry.pc.close();
    } catch {
      // ignore close errors
    }
  }

  teardownAll(): void {
    if (this.detectorTimer) {
      clearInterval(this.detectorTimer);
      this.detectorTimer = null;
    }
    if (this.synthCadenceTimer) {
      clearInterval(this.synthCadenceTimer);
      this.synthCadenceTimer = null;
    }
    for (const peerId of Array.from(this.peers.keys())) {
      this.closePeer(peerId);
    }
    try {
      this.synthOscLow?.stop();
      this.synthOscHigh?.stop();
    } catch {
      // oscillators already stopped
    }
    this.synthOscLow = null;
    this.synthOscHigh = null;
    this.synthEnvelopeGain = null;
    this.synthMonitorGain = null;

    if (this.hardwareStream) {
      this.hardwareStream.getTracks().forEach((t) => t.stop());
      this.hardwareStream = null;
    }
    this.outgoingDest = null;
    this.outgoingInputGain = null;
    this.localAnalyser = null;

    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}

const runtime = new VoiceMeshRuntime();

function createAudioContext(): AudioContext {
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  return new Ctor();
}

function computeRms(
  analyser: AnalyserNode,
  buf: Uint8Array<ArrayBuffer>
): number {
  analyser.getByteTimeDomainData(buf);
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    const norm = (buf[i] - 128) / 128;
    sumSq += norm * norm;
  }
  return Math.sqrt(sumSq / buf.length);
}

async function setupLocalAudioPipeline(
  store: ReturnType<typeof useStore>,
  setRemoteSpeaking: (next: Record<string, boolean>) => void
): Promise<{ usingFallbackSynth: boolean; fallbackBanner: string | null }> {
  runtime.teardownAll();

  const ctx = createAudioContext();
  await ctx.resume().catch(() => {});
  runtime.audioCtx = ctx;

  const outgoingDest = ctx.createMediaStreamDestination();
  const outgoingInputGain = ctx.createGain();
  outgoingInputGain.gain.value = 1;

  const localAnalyser = ctx.createAnalyser();
  localAnalyser.fftSize = 256;

  outgoingInputGain.connect(localAnalyser);
  outgoingInputGain.connect(outgoingDest);

  runtime.outgoingDest = outgoingDest;
  runtime.outgoingInputGain = outgoingInputGain;
  runtime.localAnalyser = localAnalyser;

  // 240Hz + 360Hz harmonic synth voice generator (fallback & Test Tone)
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 920;

  const oscLow = ctx.createOscillator();
  oscLow.type = 'triangle';
  oscLow.frequency.value = 240;

  const oscHigh = ctx.createOscillator();
  oscHigh.type = 'sine';
  oscHigh.frequency.value = 360;

  const synthGain = ctx.createGain();
  synthGain.gain.value = 0;

  const monitorGain = ctx.createGain();
  monitorGain.gain.value = 0;

  oscLow.connect(filter);
  oscHigh.connect(filter);
  filter.connect(synthGain);
  synthGain.connect(outgoingInputGain);
  synthGain.connect(monitorGain);
  monitorGain.connect(ctx.destination);

  oscLow.start();
  oscHigh.start();

  runtime.synthOscLow = oscLow;
  runtime.synthOscHigh = oscHigh;
  runtime.synthEnvelopeGain = synthGain;
  runtime.synthMonitorGain = monitorGain;

  let usingFallbackSynth = false;
  let fallbackBanner: string | null = null;

  if (
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  ) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      runtime.hardwareStream = micStream;
      const micSource = ctx.createMediaStreamSource(micStream);
      micSource.connect(outgoingInputGain);
    } catch {
      usingFallbackSynth = true;
      fallbackBanner = 'No microphone, so the others hear a test tone.';
    }
  } else {
    usingFallbackSynth = true;
    fallbackBanner = 'No microphone, so the others hear a test tone.';
  }

  let pulseTick = 0;
  runtime.synthCadenceTimer = setInterval(() => {
    if (!runtime.synthEnvelopeGain || !runtime.audioCtx) return;
    const groupSnap = store.get(voiceSessionAtom);
    const dmSnap = store.get(dmCallSessionAtom);
    const activeTestTone =
      groupSnap.status === 'connected'
        ? groupSnap.testToneActive && !groupSnap.muted
        : dmSnap.status === 'connected'
          ? dmSnap.testToneActive && !dmSnap.muted
          : false;
    pulseTick = (pulseTick + 1) % 6;
    const activePulse = activeTestTone && pulseTick !== 4 && pulseTick !== 5;
    const target = activePulse ? 0.24 : 0;
    runtime.synthEnvelopeGain.gain.setTargetAtTime(
      target,
      runtime.audioCtx.currentTime,
      0.035
    );
  }, 220);

  const localBuf = new Uint8Array(localAnalyser.fftSize);
  let prevGroupSpeaking = false;
  let prevDmSpeaking = false;

  runtime.detectorTimer = setInterval(() => {
    if (!runtime.localAnalyser) return;
    const groupSnap = store.get(voiceSessionAtom);
    const dmSnap = store.get(dmCallSessionAtom);

    if (groupSnap.status === 'connected') {
      const rms = groupSnap.muted
        ? 0
        : computeRms(runtime.localAnalyser, localBuf);
      const nowSpeaking = rms > 0.018;
      if (nowSpeaking !== prevGroupSpeaking) {
        prevGroupSpeaking = nowSpeaking;
        store.set(voiceSessionAtom, (prev) => ({
          ...prev,
          selfSpeaking: nowSpeaking,
        }));
        sendPodWsFrame({
          type: 'voice_state',
          muted: groupSnap.muted,
          deafened: groupSnap.deafened,
          speaking: nowSpeaking,
        });
      }
    } else if (dmSnap.status === 'connected' && dmSnap.peerId) {
      const rms = dmSnap.muted
        ? 0
        : computeRms(runtime.localAnalyser, localBuf);
      const nowSpeaking = rms > 0.018;
      if (nowSpeaking !== prevDmSpeaking) {
        prevDmSpeaking = nowSpeaking;
        store.set(dmCallSessionAtom, (prev) => ({
          ...prev,
          selfSpeaking: nowSpeaking,
        }));
        sendPodWsFrame({
          type: 'dm_call_state',
          peerId: dmSnap.peerId,
          muted: dmSnap.muted,
          speaking: nowSpeaking,
        });
      }
    }

    if (
      groupSnap.status === 'connected' ||
      dmSnap.status === 'connected'
    ) {
      const remoteNext: Record<string, boolean> = {};
      for (const [peerId, entry] of runtime.peers.entries()) {
        if (entry.analyser) {
          const pBuf = new Uint8Array(entry.analyser.fftSize);
          remoteNext[peerId] = computeRms(entry.analyser, pBuf) > 0.016;
        }
      }
      setRemoteSpeaking(remoteNext);
    }
  }, 120);

  return { usingFallbackSynth, fallbackBanner };
}

export function useVoiceEngineController(): void {
  const store = useStore();
  const activePodId = useAtomValue(activePodIdAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);
  const session = useAtomValue(voiceSessionAtom);
  const dmSession = useAtomValue(dmCallSessionAtom);
  const incomingDmCall = useAtomValue(incomingDmCallAtom);
  const dmCallNotice = useAtomValue(dmCallNoticeAtom);
  const peerVolumes = useAtomValue(peerVolumeMapAtom);
  const setRemoteSpeaking = useSetAtom(remoteSpeakingMapAtom);

  const ensurePeerConnection = useCallback(
    (
      remotePeerId: string,
      selfPeerId: string,
      shouldInitiate: boolean,
      scope: VoiceCallScope = 'GROUP'
    ): PeerConnectionEntry | null => {
      if (!runtime.outgoingDest || !runtime.audioCtx) return null;

      let entry = runtime.peers.get(remotePeerId);
      if (entry && entry.scope !== scope) {
        runtime.closePeer(remotePeerId);
        entry = undefined;
      }

      if (!entry) {
        const pc = new RTCPeerConnection(RTC_CONFIG);
        const outgoingStream = runtime.outgoingDest.stream;
        outgoingStream.getAudioTracks().forEach((track) => {
          pc.addTrack(track, outgoingStream);
        });

        const created: PeerConnectionEntry = {
          peerId: remotePeerId,
          scope,
          pc,
          pendingCandidates: [],
          offerSent: false,
          audioEl: null,
          gainNode: null,
          analyser: null,
          sourceNode: null,
        };
        runtime.peers.set(remotePeerId, created);
        entry = created;

        pc.onicecandidate = (ev) => {
          if (!ev.candidate) return;
          sendPodWsFrame({
            type: 'webrtc_signal',
            targetPeerId: remotePeerId,
            scope,
            signal: { candidate: ev.candidate.toJSON() },
          });
        };

        pc.ontrack = (ev) => {
          const stream = ev.streams[0] || new MediaStream([ev.track]);
          const container = runtime.ensureAudioContainer();
          if (!created.audioEl) {
            const audio = document.createElement('audio');
            audio.autoplay = true;
            audio.setAttribute('playsinline', 'true');
            // Muted <audio> pumps Chromium's WebRTC decoder while WebAudio GainNode provides 0%..150% volume.
            audio.muted = true;
            audio.srcObject = stream;
            container.appendChild(audio);
            audio.play().catch(() => {});
            created.audioEl = audio;
          } else {
            created.audioEl.srcObject = stream;
            created.audioEl.play().catch(() => {});
          }

          if (runtime.audioCtx && !created.sourceNode) {
            const ctx = runtime.audioCtx;
            const source = ctx.createMediaStreamSource(stream);
            const gain = ctx.createGain();
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;

            const isDeafened =
              scope === 'DM'
                ? store.get(dmCallSessionAtom).deafened
                : store.get(voiceSessionAtom).deafened;
            const currentVolumes = store.get(peerVolumeMapAtom);
            const peerVol = currentVolumes[remotePeerId] ?? 1.0;
            gain.gain.value = isDeafened ? 0 : peerVol;

            source.connect(analyser);
            analyser.connect(gain);
            gain.connect(ctx.destination);

            created.sourceNode = source;
            created.gainNode = gain;
            created.analyser = analyser;
          }
        };
      }

      if (shouldInitiate && !entry.offerSent && selfPeerId < remotePeerId) {
        entry.offerSent = true;
        entry.pc
          .createOffer()
          .then((offer) => entry!.pc.setLocalDescription(offer))
          .then(() => {
            if (!entry?.pc.localDescription) return;
            sendPodWsFrame({
              type: 'webrtc_signal',
              targetPeerId: remotePeerId,
              scope,
              signal: { sdp: entry.pc.localDescription.toJSON() },
            });
          })
          .catch(() => {
            if (entry) entry.offerSent = false;
          });
      }

      return entry;
    },
    [store]
  );

  // Sync Group Call peer mesh when voicePeers updates
  useEffect(() => {
    if (
      session.status !== 'connected' ||
      !session.podId ||
      !session.selfPeerId
    ) {
      return;
    }
    const peersInCall: VoicePeer[] = voicePeersByPod[session.podId] || [];
    const activeRemoteIds = new Set(
      peersInCall
        .map((p) => p.peerId)
        .filter((id) => id !== session.selfPeerId)
    );

    for (const [existingPeerId, existingEntry] of Array.from(
      runtime.peers.entries()
    )) {
      if (
        existingEntry.scope === 'GROUP' &&
        !activeRemoteIds.has(existingPeerId)
      ) {
        runtime.closePeer(existingPeerId);
      }
    }

    for (const remotePeerId of activeRemoteIds) {
      ensurePeerConnection(remotePeerId, session.selfPeerId, true, 'GROUP');
    }
  }, [
    ensurePeerConnection,
    session.podId,
    session.selfPeerId,
    session.status,
    voicePeersByPod,
  ]);

  // Sync 1:1 DM Call WebRTC connection once connected and local audio pipeline is ready
  useEffect(() => {
    if (
      dmSession.status !== 'connected' ||
      !dmSession.peerId ||
      !dmSession.selfPeerId
    ) {
      return;
    }
    ensurePeerConnection(dmSession.peerId, dmSession.selfPeerId, true, 'DM');
  }, [
    dmSession.peerId,
    dmSession.selfPeerId,
    dmSession.status,
    dmSession.usingFallbackSynth,
    ensurePeerConnection,
  ]);

  // Play gentle two-tone chime while incomingDmCallAtom is active
  useEffect(() => {
    if (incomingDmCall) {
      runtime.startIncomingChime();
    } else {
      runtime.stopIncomingChime();
    }
    return () => {
      runtime.stopIncomingChime();
    };
  }, [incomingDmCall]);

  // Auto-dismiss transient DM call notices
  useEffect(() => {
    if (!dmCallNotice) return;
    const t = setTimeout(() => {
      store.set(dmCallNoticeAtom, (cur) => (cur === dmCallNotice ? null : cur));
    }, 4500);
    return () => clearTimeout(t);
  }, [dmCallNotice, store]);

  // Handle incoming WebRTC SDP / ICE frames & DM Call signaling frames
  useEffect(() => {
    const unsubSignal = subscribeWebRtcSignals(async (frame) => {
      const frameScope: VoiceCallScope =
        frame.scope === 'DM' ? 'DM' : 'GROUP';

      let selfPeerId: string | null = null;
      if (frameScope === 'DM') {
        const currentDm = store.get(dmCallSessionAtom);
        if (
          (currentDm.status !== 'connected' &&
            currentDm.status !== 'connecting') ||
          !currentDm.selfPeerId ||
          currentDm.peerId !== frame.fromPeerId
        ) {
          return;
        }
        selfPeerId = currentDm.selfPeerId;
      } else {
        const currentGroup = store.get(voiceSessionAtom);
        if (currentGroup.status !== 'connected' || !currentGroup.selfPeerId) {
          return;
        }
        selfPeerId = currentGroup.selfPeerId;
      }

      const entry = ensurePeerConnection(
        frame.fromPeerId,
        selfPeerId,
        false,
        frameScope
      );
      if (!entry) return;

      const { pc } = entry;
      const { sdp, candidate } = frame.signal ?? {};

      try {
        if (sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          while (entry.pendingCandidates.length > 0) {
            const queued = entry.pendingCandidates.shift();
            if (queued) {
              await pc.addIceCandidate(new RTCIceCandidate(queued));
            }
          }
          if (sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            if (pc.localDescription) {
              sendPodWsFrame({
                type: 'webrtc_signal',
                targetPeerId: frame.fromPeerId,
                scope: frameScope,
                signal: { sdp: pc.localDescription.toJSON() },
              });
            }
          }
        } else if (candidate) {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } else {
            entry.pendingCandidates.push(candidate);
          }
        }
      } catch {
        // ignore transient signaling race on peer disconnect
      }
    });

    const unsubDmCall = subscribeDmCallEvents((eventPodId, event) => {
      const resolveSelfPeerId = (): string => {
        const curDm = store.get(dmCallSessionAtom);
        if (curDm.selfPeerId) return curDm.selfPeerId;
        const pres = store.get(presenceByPodAtom)[eventPodId];
        if (pres?.selfPeerId) return pres.selfPeerId;
        const pod = store
          .get(podsQueryAtom)
          .data?.pods.find((p) => p.podId === eventPodId);
        return pod?.myPeerId || '';
      };

      switch (event.type) {
        case 'dm_call_ringing': {
          store.set(dmCallSessionAtom, (prev) => {
            if (
              prev.status !== 'ringing' ||
              prev.peerId !== event.targetPeerId
            ) {
              return prev;
            }
            return {
              ...prev,
              peerAlias: event.targetAlias || prev.peerAlias,
              peerColor: event.targetColor || prev.peerColor,
              targetOnline: event.targetOnline,
            };
          });
          break;
        }

        case 'dm_call_incoming': {
          store.set(incomingDmCallAtom, {
            podId: eventPodId,
            fromPeerId: event.fromPeerId,
            fromAlias: event.fromAlias,
            fromColor: event.fromColor || '#1f6b3a',
          });
          break;
        }

        case 'dm_call_connected': {
          const selfPeerId = resolveSelfPeerId();
          if (
            selfPeerId &&
            event.peerAId !== selfPeerId &&
            event.peerBId !== selfPeerId
          ) {
            return;
          }
          const otherPeerId =
            selfPeerId === event.peerAId ? event.peerBId : event.peerAId;
          const otherAlias =
            selfPeerId === event.peerAId ? event.peerBAlias : event.peerAAlias;

          store.set(incomingDmCallAtom, (cur) =>
            cur && cur.fromPeerId === otherPeerId ? null : cur
          );

          store.set(dmCallSessionAtom, (prev) => ({
            ...prev,
            podId: eventPodId,
            selfPeerId: selfPeerId || prev.selfPeerId,
            peerId: otherPeerId,
            peerAlias: otherAlias || prev.peerAlias || 'Pod Member',
            status: 'connected',
            connectedAtMs: prev.connectedAtMs ?? Date.now(),
          }));

          if (selfPeerId && otherPeerId) {
            ensurePeerConnection(otherPeerId, selfPeerId, true, 'DM');
          }
          break;
        }

        case 'dm_call_state': {
          store.set(dmCallSessionAtom, (prev) => {
            if (prev.peerId !== event.fromPeerId) return prev;
            return {
              ...prev,
              peerMuted: event.muted,
              peerSpeaking: event.speaking,
            };
          });
          break;
        }

        case 'dm_call_ended': {
          const curIncoming = store.get(incomingDmCallAtom);
          const curDm = store.get(dmCallSessionAtom);

          if (
            curIncoming &&
            (curIncoming.fromPeerId === event.byPeerId ||
              curDm.status === 'idle')
          ) {
            store.set(incomingDmCallAtom, null);
          }

          if (
            curDm.status !== 'idle' &&
            (curDm.peerId === event.byPeerId ||
              curDm.selfPeerId === event.byPeerId ||
              curIncoming === null)
          ) {
            const peerAlias = curDm.peerAlias || 'Member';
            const wasSelf =
              Boolean(curDm.selfPeerId) && event.byPeerId === curDm.selfPeerId;
            runtime.teardownAll();
            store.set(dmCallSessionAtom, INITIAL_DM_CALL_STATE);
            setRemoteSpeaking({});
            if (!wasSelf) {
              if (event.reason === 'declined') {
                store.set(
                  dmCallNoticeAtom,
                  `${peerAlias} declined the call.`
                );
              } else if (event.reason === 'disconnected') {
                store.set(
                  dmCallNoticeAtom,
                  `The call with ${peerAlias} dropped.`
                );
              } else if (curDm.status === 'connected') {
                store.set(
                  dmCallNoticeAtom,
                  `The call with ${peerAlias} ended.`
                );
              }
            }
          }
          break;
        }

        case 'member_removed': {
          const curIncoming = store.get(incomingDmCallAtom);
          if (curIncoming && curIncoming.fromPeerId === event.peerId) {
            store.set(incomingDmCallAtom, null);
          }
          const curDm = store.get(dmCallSessionAtom);
          if (
            curDm.status !== 'idle' &&
            (curDm.peerId === event.peerId || curDm.selfPeerId === event.peerId)
          ) {
            runtime.teardownAll();
            store.set(dmCallSessionAtom, INITIAL_DM_CALL_STATE);
            setRemoteSpeaking({});
          }
          break;
        }
      }
    });

    const unsubOpen = subscribeWsOpen((reconnectedPodId) => {
      const current = store.get(voiceSessionAtom);
      if (current.status === 'connected' && current.podId === reconnectedPodId) {
        sendPodWsFrame({
          type: 'voice_join',
          muted: current.muted,
          deafened: current.deafened,
        });
      }
      const curDm = store.get(dmCallSessionAtom);
      if (curDm.status !== 'idle' && curDm.podId === reconnectedPodId) {
        // Server clears active 1:1 DM call pairs on WS disconnect; reset cleanly so UI never hangs.
        runtime.teardownAll();
        store.set(dmCallSessionAtom, INITIAL_DM_CALL_STATE);
        setRemoteSpeaking({});
      }
    });

    return () => {
      unsubSignal();
      unsubDmCall();
      unsubOpen();
    };
  }, [ensurePeerConnection, setRemoteSpeaking, store]);

  // Apply per-peer volume, deafened state & Test Tone monitor across Group or 1:1 DM calls
  const effectiveDeafened =
    dmSession.status !== 'idle' ? dmSession.deafened : session.deafened;
  const effectiveMuted =
    dmSession.status !== 'idle' ? dmSession.muted : session.muted;
  const effectiveTestTone =
    dmSession.status !== 'idle'
      ? dmSession.testToneActive
      : session.testToneActive;

  useEffect(() => {
    for (const [peerId, entry] of runtime.peers.entries()) {
      if (entry.gainNode && runtime.audioCtx) {
        const vol = effectiveDeafened ? 0 : (peerVolumes[peerId] ?? 1.0);
        entry.gainNode.gain.setTargetAtTime(
          vol,
          runtime.audioCtx.currentTime,
          0.02
        );
      }
    }
    if (runtime.synthMonitorGain && runtime.audioCtx) {
      const monitorTarget =
        effectiveTestTone && !effectiveMuted && !effectiveDeafened ? 0.045 : 0;
      runtime.synthMonitorGain.gain.setTargetAtTime(
        monitorTarget,
        runtime.audioCtx.currentTime,
        0.03
      );
    }
  }, [effectiveDeafened, effectiveMuted, effectiveTestTone, peerVolumes]);

  // Cleanly disconnect previous pod's voice or DM call session when switching pods
  useEffect(() => {
    if (session.podId && activePodId && session.podId !== activePodId) {
      sendPodWsFrame({ type: 'voice_leave' });
      runtime.teardownAll();
      store.set(voiceSessionAtom, INITIAL_VOICE_STATE);
      setRemoteSpeaking({});
    }
    if (dmSession.podId && activePodId && dmSession.podId !== activePodId) {
      if (dmSession.peerId) {
        sendPodWsFrame({ type: 'dm_call_end', peerId: dmSession.peerId });
      }
      runtime.teardownAll();
      store.set(dmCallSessionAtom, INITIAL_DM_CALL_STATE);
      setRemoteSpeaking({});
    }
    if (
      incomingDmCall &&
      activePodId &&
      incomingDmCall.podId !== activePodId
    ) {
      store.set(incomingDmCallAtom, null);
    }
  }, [
    activePodId,
    dmSession.peerId,
    dmSession.podId,
    incomingDmCall,
    session.podId,
    setRemoteSpeaking,
    store,
  ]);
}

export function useVoiceActions() {
  const [session, setSession] = useAtom(voiceSessionAtom);
  const [dmSession, setDmSession] = useAtom(dmCallSessionAtom);
  const [incomingDmCall, setIncomingDmCall] = useAtom(incomingDmCallAtom);
  const [dmCallNotice, setDmCallNotice] = useAtom(dmCallNoticeAtom);
  const [peerVolumes, setPeerVolumes] = useAtom(peerVolumeMapAtom);
  const setRemoteSpeaking = useSetAtom(remoteSpeakingMapAtom);
  const presenceByPod = useAtomValue(presenceByPodAtom);
  const podsQuery = useAtomValue(podsQueryAtom);
  const store = useStore();

  const leaveVoice = useCallback(() => {
    sendPodWsFrame({ type: 'voice_leave' });
    runtime.teardownAll();
    setSession(INITIAL_VOICE_STATE);
    setRemoteSpeaking({});
  }, [setRemoteSpeaking, setSession]);

  const endDmCall = useCallback(() => {
    const curDm = store.get(dmCallSessionAtom);
    if (curDm.peerId) {
      sendPodWsFrame({ type: 'dm_call_end', peerId: curDm.peerId });
    }
    runtime.teardownAll();
    setDmSession(INITIAL_DM_CALL_STATE);
    setRemoteSpeaking({});
  }, [setDmSession, setRemoteSpeaking, store]);

  const joinVoice = useCallback(
    async (podId: string, podLabel?: string) => {
      const current = store.get(voiceSessionAtom);
      if (current.status === 'connected' && current.podId === podId) {
        return;
      }

      const curDm = store.get(dmCallSessionAtom);
      if (curDm.status !== 'idle') {
        if (curDm.peerId) {
          sendPodWsFrame({ type: 'dm_call_end', peerId: curDm.peerId });
        }
        setDmSession(INITIAL_DM_CALL_STATE);
      }

      if (current.status !== 'idle') {
        sendPodWsFrame({ type: 'voice_leave' });
      }

      const podObj = podsQuery.data?.pods.find((p) => p.podId === podId);
      const selfPeerId =
        presenceByPod[podId]?.selfPeerId || podObj?.myPeerId || null;
      const resolvedLabel =
        podLabel ||
        (podObj?.title
          ? podObj.title
          : podObj
            ? `#${podObj.code}`
            : 'Pod Audio Call');

      setSession({
        ...INITIAL_VOICE_STATE,
        podId,
        podLabel: resolvedLabel,
        selfPeerId,
        status: 'connecting',
      });

      const { usingFallbackSynth, fallbackBanner } =
        await setupLocalAudioPipeline(store, setRemoteSpeaking);

      setSession({
        podId,
        podLabel: resolvedLabel,
        selfPeerId,
        status: 'connected',
        usingFallbackSynth,
        fallbackBanner,
        testToneActive: false,
        muted: false,
        deafened: false,
        selfSpeaking: false,
      });

      sendPodWsFrame({
        type: 'voice_join',
        muted: false,
        deafened: false,
      });
    },
    [
      podsQuery.data?.pods,
      presenceByPod,
      setDmSession,
      setRemoteSpeaking,
      setSession,
      store,
    ]
  );

  const startDmCall = useCallback(
    async (
      podId: string,
      peerId: string,
      peerAlias: string,
      peerColor = '#1f6b3a'
    ) => {
      const curDm = store.get(dmCallSessionAtom);
      if (
        (curDm.status === 'ringing' || curDm.status === 'connected') &&
        curDm.podId === podId &&
        curDm.peerId === peerId
      ) {
        return;
      }

      if (curDm.status !== 'idle' && curDm.peerId) {
        sendPodWsFrame({ type: 'dm_call_end', peerId: curDm.peerId });
      }

      const curGroup = store.get(voiceSessionAtom);
      if (curGroup.status !== 'idle') {
        sendPodWsFrame({ type: 'voice_leave' });
        setSession(INITIAL_VOICE_STATE);
      }

      const podObj = podsQuery.data?.pods.find((p) => p.podId === podId);
      const selfPeerId =
        presenceByPod[podId]?.selfPeerId || podObj?.myPeerId || null;
      const memberOnline =
        presenceByPod[podId]?.members.find((m) => m.peerId === peerId)
          ?.online ??
        podObj?.members.find((m) => m.peerId === peerId)?.online ??
        true;

      setDmCallNotice(null);
      setDmSession({
        ...INITIAL_DM_CALL_STATE,
        podId,
        selfPeerId,
        peerId,
        peerAlias,
        peerColor,
        targetOnline: memberOnline,
        status: 'ringing',
      });

      const { usingFallbackSynth, fallbackBanner } =
        await setupLocalAudioPipeline(store, setRemoteSpeaking);

      // Guard against user cancelling while mic permission prompt was open
      const afterSetup = store.get(dmCallSessionAtom);
      if (afterSetup.status === 'idle' || afterSetup.peerId !== peerId) {
        runtime.teardownAll();
        return;
      }

      setDmSession((prev) =>
        prev.peerId === peerId
          ? {
              ...prev,
              usingFallbackSynth,
              fallbackBanner,
            }
          : prev
      );

      sendPodWsFrame({
        type: 'dm_call_ring',
        targetPeerId: peerId,
      });
    },
    [
      podsQuery.data?.pods,
      presenceByPod,
      setDmCallNotice,
      setDmSession,
      setRemoteSpeaking,
      setSession,
      store,
    ]
  );

  const acceptDmCall = useCallback(async () => {
    const incoming = store.get(incomingDmCallAtom);
    if (!incoming) return;

    setIncomingDmCall(null);
    setDmCallNotice(null);

    const curDm = store.get(dmCallSessionAtom);
    if (
      curDm.status !== 'idle' &&
      curDm.peerId &&
      curDm.peerId !== incoming.fromPeerId
    ) {
      sendPodWsFrame({ type: 'dm_call_end', peerId: curDm.peerId });
    }

    const curGroup = store.get(voiceSessionAtom);
    if (curGroup.status !== 'idle') {
      sendPodWsFrame({ type: 'voice_leave' });
      setSession(INITIAL_VOICE_STATE);
    }

    const podObj = podsQuery.data?.pods.find(
      (p) => p.podId === incoming.podId
    );
    const selfPeerId =
      presenceByPod[incoming.podId]?.selfPeerId || podObj?.myPeerId || null;

    setDmSession({
      ...INITIAL_DM_CALL_STATE,
      podId: incoming.podId,
      selfPeerId,
      peerId: incoming.fromPeerId,
      peerAlias: incoming.fromAlias,
      peerColor: incoming.fromColor || '#1f6b3a',
      targetOnline: true,
      status: 'connecting',
    });

    const { usingFallbackSynth, fallbackBanner } =
      await setupLocalAudioPipeline(store, setRemoteSpeaking);

    const afterSetup = store.get(dmCallSessionAtom);
    if (
      afterSetup.status === 'idle' ||
      afterSetup.peerId !== incoming.fromPeerId
    ) {
      runtime.teardownAll();
      return;
    }

    setDmSession((prev) =>
      prev.peerId === incoming.fromPeerId
        ? {
            ...prev,
            usingFallbackSynth,
            fallbackBanner,
          }
        : prev
    );

    sendPodWsFrame({
      type: 'dm_call_accept',
      callerPeerId: incoming.fromPeerId,
    });
  }, [
    podsQuery.data?.pods,
    presenceByPod,
    setDmCallNotice,
    setDmSession,
    setIncomingDmCall,
    setRemoteSpeaking,
    setSession,
    store,
  ]);

  const declineDmCall = useCallback(() => {
    const incoming = store.get(incomingDmCallAtom);
    if (!incoming) return;
    sendPodWsFrame({
      type: 'dm_call_decline',
      callerPeerId: incoming.fromPeerId,
    });
    setIncomingDmCall(null);
  }, [setIncomingDmCall, store]);

  const applyLocalMuteHardware = (nextMuted: boolean) => {
    if (runtime.outgoingInputGain && runtime.audioCtx) {
      runtime.outgoingInputGain.gain.setTargetAtTime(
        nextMuted ? 0 : 1,
        runtime.audioCtx.currentTime,
        0.02
      );
    }
    if (runtime.hardwareStream) {
      runtime.hardwareStream.getAudioTracks().forEach((t) => {
        t.enabled = !nextMuted;
      });
    }
  };

  const toggleMute = useCallback(() => {
    const curDm = store.get(dmCallSessionAtom);
    if (curDm.status === 'connected' && curDm.peerId) {
      const nextMuted = !curDm.muted;
      applyLocalMuteHardware(nextMuted);
      sendPodWsFrame({
        type: 'dm_call_state',
        peerId: curDm.peerId,
        muted: nextMuted,
        speaking: nextMuted ? false : curDm.selfSpeaking,
      });
      setDmSession((prev) => ({
        ...prev,
        muted: nextMuted,
        selfSpeaking: nextMuted ? false : prev.selfSpeaking,
      }));
      return;
    }

    setSession((prev) => {
      if (prev.status !== 'connected') return prev;
      const nextMuted = !prev.muted;
      applyLocalMuteHardware(nextMuted);
      sendPodWsFrame({
        type: 'voice_state',
        muted: nextMuted,
        deafened: prev.deafened,
        speaking: nextMuted ? false : prev.selfSpeaking,
      });
      return {
        ...prev,
        muted: nextMuted,
        selfSpeaking: nextMuted ? false : prev.selfSpeaking,
      };
    });
  }, [setDmSession, setSession, store]);

  const toggleDeafen = useCallback(() => {
    const curDm = store.get(dmCallSessionAtom);
    if (curDm.status === 'connected' && curDm.peerId) {
      const nextDeafened = !curDm.deafened;
      const nextMuted = nextDeafened ? true : curDm.muted;
      applyLocalMuteHardware(nextMuted);
      sendPodWsFrame({
        type: 'dm_call_state',
        peerId: curDm.peerId,
        muted: nextMuted,
        speaking: false,
      });
      setDmSession((prev) => ({
        ...prev,
        muted: nextMuted,
        deafened: nextDeafened,
        selfSpeaking: false,
      }));
      return;
    }

    setSession((prev) => {
      if (prev.status !== 'connected') return prev;
      const nextDeafened = !prev.deafened;
      const nextMuted = nextDeafened ? true : prev.muted;
      applyLocalMuteHardware(nextMuted);
      sendPodWsFrame({
        type: 'voice_state',
        muted: nextMuted,
        deafened: nextDeafened,
        speaking: false,
      });
      return {
        ...prev,
        muted: nextMuted,
        deafened: nextDeafened,
        selfSpeaking: false,
      };
    });
  }, [setDmSession, setSession, store]);

  const toggleTestTone = useCallback(() => {
    if (runtime.audioCtx && runtime.audioCtx.state === 'suspended') {
      runtime.audioCtx.resume().catch(() => {});
    }
    const curDm = store.get(dmCallSessionAtom);
    if (curDm.status === 'connected') {
      const nextActive = !curDm.testToneActive;
      const nextMuted = nextActive ? false : curDm.muted;
      if (nextActive) {
        applyLocalMuteHardware(false);
        if (curDm.muted && curDm.peerId) {
          sendPodWsFrame({
            type: 'dm_call_state',
            peerId: curDm.peerId,
            muted: false,
            speaking: curDm.selfSpeaking,
          });
        }
      }
      setDmSession((prev) => ({
        ...prev,
        testToneActive: nextActive,
        muted: nextMuted,
      }));
      return;
    }

    setSession((prev) => {
      if (prev.status !== 'connected') return prev;
      const nextActive = !prev.testToneActive;
      const nextMuted = nextActive ? false : prev.muted;
      if (nextActive) {
        applyLocalMuteHardware(false);
      }
      return {
        ...prev,
        testToneActive: nextActive,
        muted: nextMuted,
      };
    });
  }, [setDmSession, setSession, store]);

  const setPeerVolume = useCallback(
    (peerId: string, volume: number) => {
      const clamped = Math.max(0, Math.min(1.5, volume));
      setPeerVolumes((prev) => ({
        ...prev,
        [peerId]: clamped,
      }));
    },
    [setPeerVolumes]
  );

  const clearDmCallNotice = useCallback(() => {
    setDmCallNotice(null);
  }, [setDmCallNotice]);

  return {
    session,
    dmSession,
    incomingDmCall,
    dmCallNotice,
    clearDmCallNotice,
    peerVolumes,
    joinVoice,
    leaveVoice,
    startDmCall,
    acceptDmCall,
    declineDmCall,
    endDmCall,
    toggleMute,
    toggleDeafen,
    toggleTestTone,
    setPeerVolume,
  };
}

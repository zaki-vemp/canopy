'use client';

import { useCallback, useEffect } from 'react';
import { atom, useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import {
  activePodIdAtom,
  presenceByPodAtom,
  podsQueryAtom,
  voiceRosterByPodAtom,
} from '@/state/workspaceAtoms';
import {
  sendPodWsFrame,
  subscribeWebRtcSignals,
  subscribeWsOpen,
} from '@/state/wsPodClient';
import type { VoicePeer } from '@/types/canopy';

export interface VoiceSessionState {
  podId: string | null;
  voiceChannelId: string | null;
  voiceChannelLabel: string;
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
  voiceChannelId: null,
  voiceChannelLabel: '',
  selfPeerId: null,
  status: 'idle',
  usingFallbackSynth: false,
  fallbackBanner: null,
  testToneActive: false,
  muted: false,
  deafened: false,
  selfSpeaking: false,
};

export const voiceSessionAtom = atom<VoiceSessionState>(INITIAL_VOICE_STATE);

// Per-peer volume multiplier: 0.0 (0%) .. 1.5 (150%), default 1.0 (100%)
export const peerVolumeMapAtom = atom<Record<string, number>>({});

// Remote WebAudio AnalyserNode speaking flags keyed by peerId
export const remoteSpeakingMapAtom = atom<Record<string, boolean>>({});

interface PeerConnectionEntry {
  peerId: string;
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

function computeRms(analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buf);
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    const norm = (buf[i] - 128) / 128;
    sumSq += norm * norm;
  }
  return Math.sqrt(sumSq / buf.length);
}

export function useVoiceEngineController(): void {
  const store = useStore();
  const activePodId = useAtomValue(activePodIdAtom);
  const voiceRosterByPod = useAtomValue(voiceRosterByPodAtom);
  const session = useAtomValue(voiceSessionAtom);
  const peerVolumes = useAtomValue(peerVolumeMapAtom);
  const setRemoteSpeaking = useSetAtom(remoteSpeakingMapAtom);

  const ensurePeerConnection = useCallback(
    (
      remotePeerId: string,
      voiceChannelId: string,
      selfPeerId: string,
      shouldInitiate: boolean
    ): PeerConnectionEntry | null => {
      if (!runtime.outgoingDest || !runtime.audioCtx) return null;

      let entry = runtime.peers.get(remotePeerId);
      if (!entry) {
        const pc = new RTCPeerConnection(RTC_CONFIG);
        const outgoingStream = runtime.outgoingDest.stream;
        outgoingStream.getAudioTracks().forEach((track) => {
          pc.addTrack(track, outgoingStream);
        });

        const created: PeerConnectionEntry = {
          peerId: remotePeerId,
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
            voiceChannelId,
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

            const currentSession = store.get(voiceSessionAtom);
            const currentVolumes = store.get(peerVolumeMapAtom);
            const peerVol = currentVolumes[remotePeerId] ?? 1.0;
            gain.gain.value = currentSession.deafened ? 0 : peerVol;

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
              voiceChannelId,
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

  // Sync peer mesh when voiceRoster updates
  useEffect(() => {
    if (
      session.status !== 'connected' ||
      !session.podId ||
      !session.voiceChannelId ||
      !session.selfPeerId
    ) {
      return;
    }
    const podRoster = voiceRosterByPod[session.podId] || {};
    const peersInChannel: VoicePeer[] = podRoster[session.voiceChannelId] || [];
    const activeRemoteIds = new Set(
      peersInChannel
        .map((p) => p.peerId)
        .filter((id) => id !== session.selfPeerId)
    );

    for (const existingPeerId of Array.from(runtime.peers.keys())) {
      if (!activeRemoteIds.has(existingPeerId)) {
        runtime.closePeer(existingPeerId);
      }
    }

    for (const remotePeerId of activeRemoteIds) {
      ensurePeerConnection(
        remotePeerId,
        session.voiceChannelId,
        session.selfPeerId,
        true
      );
    }
  }, [
    ensurePeerConnection,
    session.podId,
    session.selfPeerId,
    session.status,
    session.voiceChannelId,
    voiceRosterByPod,
  ]);

  // Handle incoming WebRTC SDP / ICE frames
  useEffect(() => {
    const unsubSignal = subscribeWebRtcSignals(async (frame) => {
      const current = store.get(voiceSessionAtom);
      if (
        current.status !== 'connected' ||
        current.voiceChannelId !== frame.voiceChannelId ||
        !current.selfPeerId
      ) {
        return;
      }

      const entry = ensurePeerConnection(
        frame.fromPeerId,
        frame.voiceChannelId,
        current.selfPeerId,
        false
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
                voiceChannelId: frame.voiceChannelId,
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

    const unsubOpen = subscribeWsOpen((reconnectedPodId) => {
      const current = store.get(voiceSessionAtom);
      if (
        current.status === 'connected' &&
        current.podId === reconnectedPodId &&
        current.voiceChannelId
      ) {
        sendPodWsFrame({
          type: 'voice_join',
          voiceChannelId: current.voiceChannelId,
          muted: current.muted,
          deafened: current.deafened,
        });
      }
    });

    return () => {
      unsubSignal();
      unsubOpen();
    };
  }, [ensurePeerConnection, store]);

  // Apply per-peer volume & deafened state in real time
  useEffect(() => {
    for (const [peerId, entry] of runtime.peers.entries()) {
      if (entry.gainNode && runtime.audioCtx) {
        const vol = session.deafened ? 0 : (peerVolumes[peerId] ?? 1.0);
        entry.gainNode.gain.setTargetAtTime(
          vol,
          runtime.audioCtx.currentTime,
          0.02
        );
      }
    }
    if (runtime.synthMonitorGain && runtime.audioCtx) {
      const monitorTarget =
        session.testToneActive && !session.muted && !session.deafened
          ? 0.045
          : 0;
      runtime.synthMonitorGain.gain.setTargetAtTime(
        monitorTarget,
        runtime.audioCtx.currentTime,
        0.03
      );
    }
  }, [peerVolumes, session.deafened, session.muted, session.testToneActive]);

  // If user switches to a different pod, cleanly disconnect previous pod's voice session
  useEffect(() => {
    if (session.podId && activePodId && session.podId !== activePodId) {
      sendPodWsFrame({ type: 'voice_leave' });
      runtime.teardownAll();
      store.set(voiceSessionAtom, INITIAL_VOICE_STATE);
      setRemoteSpeaking({});
    }
  }, [activePodId, session.podId, setRemoteSpeaking, store]);
}

export function useVoiceActions() {
  const [session, setSession] = useAtom(voiceSessionAtom);
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

  const joinVoice = useCallback(
    async (podId: string, voiceChannelId: string, voiceChannelLabel: string) => {
      const current = store.get(voiceSessionAtom);
      if (
        current.status === 'connected' &&
        current.podId === podId &&
        current.voiceChannelId === voiceChannelId
      ) {
        return;
      }

      if (current.status !== 'idle') {
        sendPodWsFrame({ type: 'voice_leave' });
        runtime.teardownAll();
      }

      const podObj = podsQuery.data?.pods.find((p) => p.podId === podId);
      const selfPeerId =
        presenceByPod[podId]?.selfPeerId || podObj?.myPeerId || null;

      setSession({
        ...INITIAL_VOICE_STATE,
        podId,
        voiceChannelId,
        voiceChannelLabel,
        selfPeerId,
        status: 'connecting',
      });

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

      // Setup 240Hz + 360Hz harmonic synth voice generator (used for fallback & Test Tone)
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
          fallbackBanner = 'Mic unavailable — joined with synth voice test';
        }
      } else {
        usingFallbackSynth = true;
        fallbackBanner = 'Mic unavailable — joined with synth voice test';
      }

      // Speech-like rhythmic pulse cadence when Test Tone is enabled
      let pulseTick = 0;
      runtime.synthCadenceTimer = setInterval(() => {
        const snap = store.get(voiceSessionAtom);
        if (!runtime.synthEnvelopeGain || !runtime.audioCtx) return;
        pulseTick = (pulseTick + 1) % 6;
        const activePulse =
          snap.testToneActive && !snap.muted && pulseTick !== 4 && pulseTick !== 5;
        const target = activePulse ? 0.24 : 0;
        runtime.synthEnvelopeGain.gain.setTargetAtTime(
          target,
          runtime.audioCtx.currentTime,
          0.035
        );
      }, 220);

      // ~120ms local + remote speaking detector
      const localBuf = new Uint8Array(localAnalyser.fftSize);
      let prevSpeaking = false;

      runtime.detectorTimer = setInterval(() => {
        const snap = store.get(voiceSessionAtom);
        if (snap.status !== 'connected' || !runtime.localAnalyser) return;

        const rms = snap.muted ? 0 : computeRms(runtime.localAnalyser, localBuf);
        const nowSpeaking = rms > 0.018;

        if (nowSpeaking !== prevSpeaking) {
          prevSpeaking = nowSpeaking;
          store.set(voiceSessionAtom, (prev) => ({
            ...prev,
            selfSpeaking: nowSpeaking,
          }));
          sendPodWsFrame({
            type: 'voice_state',
            muted: snap.muted,
            deafened: snap.deafened,
            speaking: nowSpeaking,
          });
        }

        const remoteNext: Record<string, boolean> = {};
        for (const [peerId, entry] of runtime.peers.entries()) {
          if (entry.analyser) {
            const pBuf = new Uint8Array(entry.analyser.fftSize);
            remoteNext[peerId] = computeRms(entry.analyser, pBuf) > 0.016;
          }
        }
        setRemoteSpeaking(remoteNext);
      }, 120);

      setSession({
        podId,
        voiceChannelId,
        voiceChannelLabel,
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
        voiceChannelId,
        muted: false,
        deafened: false,
      });
    },
    [ podsQuery.data?.pods, presenceByPod, setRemoteSpeaking, setSession, store ]
  );

  const toggleMute = useCallback(() => {
    setSession((prev) => {
      if (prev.status !== 'connected') return prev;
      const nextMuted = !prev.muted;
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
  }, [setSession]);

  const toggleDeafen = useCallback(() => {
    setSession((prev) => {
      if (prev.status !== 'connected') return prev;
      const nextDeafened = !prev.deafened;
      const nextMuted = nextDeafened ? true : prev.muted;
      if (runtime.outgoingInputGain && runtime.audioCtx) {
        runtime.outgoingInputGain.gain.setTargetAtTime(
          nextMuted ? 0 : 1,
          runtime.audioCtx.currentTime,
          0.02
        );
      }
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
  }, [setSession]);

  const toggleTestTone = useCallback(() => {
    if (runtime.audioCtx && runtime.audioCtx.state === 'suspended') {
      runtime.audioCtx.resume().catch(() => {});
    }
    setSession((prev) => {
      if (prev.status !== 'connected') return prev;
      const nextActive = !prev.testToneActive;
      const nextMuted = nextActive ? false : prev.muted;
      if (nextActive && runtime.outgoingInputGain && runtime.audioCtx) {
        runtime.outgoingInputGain.gain.setTargetAtTime(
          1,
          runtime.audioCtx.currentTime,
          0.02
        );
      }
      return {
        ...prev,
        testToneActive: nextActive,
        muted: nextMuted,
      };
    });
  }, [setSession]);

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

  return {
    session,
    peerVolumes,
    joinVoice,
    leaveVoice,
    toggleMute,
    toggleDeafen,
    toggleTestTone,
    setPeerVolume,
  };
}

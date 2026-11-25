// The audio of a call: one peer connection per other person, same signalling as
// frontend/src/state/voiceEngine.ts so phones and the web can sit in one call.
// The lower peerId sends the offer, the other side answers.
// No React and no react-native imports here: scripts/selfcheck.mjs runs it as is.
// ponytail: a P2P Opus mesh carries ~8-10 talkers; move to an SFU above ~12.
import type { WebRtcSignalPayload, WsOutboundFrame } from '../types/canopy';

export type CallScope = 'GROUP' | 'DM';
export type LinkState = 'connecting' | 'connected' | 'failed';

export interface RtcTrack {
  enabled: boolean;
  stop(): void;
}

export interface RtcStream {
  getAudioTracks(): RtcTrack[];
  getTracks(): RtcTrack[];
}

interface RtcDescription {
  type: string | null;
  sdp?: string;
}

// The part of RTCPeerConnection that browsers and react-native-webrtc share.
export interface RtcPeer {
  connectionState: string;
  signalingState: string;
  localDescription: RtcDescription | null;
  remoteDescription: RtcDescription | null;
  onicecandidate: ((ev: { candidate: { toJSON(): unknown } | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  ontrack: ((ev: { streams: RtcStream[] }) => void) | null;
  addTrack(track: RtcTrack, stream: RtcStream): unknown;
  addTransceiver(kind: 'audio', init: { direction: 'recvonly' }): unknown;
  createOffer(options?: { iceRestart?: boolean }): Promise<RtcDescription>;
  createAnswer(): Promise<RtcDescription>;
  setLocalDescription(desc: RtcDescription): Promise<void>;
  setRemoteDescription(desc: RtcDescription): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<unknown>;
  getStats(): Promise<{ forEach(cb: (stat: RtcStat) => void): void }>;
  close(): void;
}

interface RtcStat {
  type: string;
  kind?: string;
  audioLevel?: number;
}

export interface RtcKit {
  createPeer(): RtcPeer;
  getMic(): Promise<RtcStream>;
  /** Starts playing a remote stream; the result stops it. */
  play(stream: RtcStream): () => void;
  startSession(): Promise<void> | void;
  stopSession(): void;
  setSpeaker(on: boolean): void;
}

interface Peer {
  id: string;
  pc: RtcPeer;
  pending: unknown[];
  queue: Promise<void>;
  remote: RtcStream | null;
  remoteFingerprint: string;
  stopPlaying: (() => void) | null;
  offered: boolean;
  restarts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_RESTARTS = 3;

// A peer that rebuilt its connection shows up with a new DTLS fingerprint.
function fingerprintOf(sdp: string | undefined): string {
  return sdp?.match(/a=fingerprint:(\S+ \S+)/)?.[1] ?? '';
}

export class CallEngine {
  scope: CallScope | null = null;

  private kit: RtcKit;
  private send: (frame: WsOutboundFrame) => boolean;
  private onLinks: (links: Record<string, LinkState>) => void;
  private selfPeerId = '';
  private ready = false;
  private mic: RtcStream | null = null;
  private muted = false;
  private deafened = false;
  private peers = new Map<string, Peer>();
  private links: Record<string, LinkState> = {};
  private generation = 0;

  constructor(
    kit: RtcKit,
    send: (frame: WsOutboundFrame) => boolean,
    onLinks: (links: Record<string, LinkState>) => void
  ) {
    this.kit = kit;
    this.send = send;
    this.onLinks = onLinks;
  }

  /** Takes the microphone. null means the call was closed while the permission prompt was up. */
  async open(scope: CallScope, selfPeerId: string): Promise<'live' | 'listen' | null> {
    this.close();
    const generation = ++this.generation;
    this.scope = scope;
    this.selfPeerId = selfPeerId;

    let mic: RtcStream | null = null;
    try {
      mic = await this.kit.getMic();
    } catch {
      // No microphone or no permission: join and listen.
    }
    if (generation !== this.generation) {
      mic?.getTracks().forEach((t) => t.stop());
      return null;
    }
    this.mic = mic;
    await this.kit.startSession();
    if (generation !== this.generation) return null;
    this.ready = true;
    return mic ? 'live' : 'listen';
  }

  /** Matches the connections to the people now in the call. */
  sync(peerIds: string[]): void {
    if (!this.ready) return;
    // The server drops signals from anyone it does not list in the room call yet,
    // and a lost offer is never sent twice. Wait until we are on the list.
    if (this.scope === 'GROUP' && !peerIds.includes(this.selfPeerId)) return;
    const wanted = new Set(peerIds.filter((id) => id !== this.selfPeerId));
    for (const id of Array.from(this.peers.keys())) {
      if (!wanted.has(id)) this.drop(id);
    }
    for (const id of wanted) {
      const peer = this.ensure(id);
      if (!peer.offered && this.selfPeerId < id) this.offer(peer, false);
    }
  }

  receive(fromPeerId: string, scope: CallScope, signal: WebRtcSignalPayload): void {
    if (!this.ready || this.scope !== scope || fromPeerId === this.selfPeerId) return;
    const { sdp, candidate } = signal ?? {};
    let peer = this.ensure(fromPeerId);

    if (sdp?.type === 'offer') {
      const fingerprint = fingerprintOf(sdp.sdp);
      const collides = peer.pc.signalingState === 'have-local-offer';
      // Both sides offered at once: the lower peerId's offer stands.
      if (collides && this.selfPeerId < fromPeerId) return;
      if (collides || (peer.remoteFingerprint && peer.remoteFingerprint !== fingerprint)) {
        this.drop(fromPeerId);
        peer = this.ensure(fromPeerId);
      }
      peer.remoteFingerprint = fingerprint;
    } else if (sdp) {
      peer.remoteFingerprint = fingerprintOf(sdp.sdp);
    }

    const target = peer;
    // One signal at a time per person, in arrival order.
    target.queue = target.queue
      .then(() =>
        sdp
          ? this.applyDescription(target, { type: sdp.type, sdp: sdp.sdp })
          : candidate
          ? this.applyCandidate(target, candidate)
          : undefined
      )
      .catch(() => {
        // The other side left mid-handshake; the next offer starts clean.
      });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.mic?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    for (const peer of this.peers.values()) this.applyDeafened(peer);
  }

  setSpeaker(on: boolean): void {
    if (this.scope) this.kit.setSpeaker(on);
  }

  /** 0..1 loudness of our own microphone, read from the first live connection. */
  async micLevel(): Promise<number> {
    if (!this.mic || this.muted) return 0;
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState !== 'connected') continue;
      let level = 0;
      const stats = await peer.pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'media-source' && s.kind === 'audio') {
          level = Math.max(level, s.audioLevel ?? 0);
        }
      });
      return level;
    }
    return 0;
  }

  /** Forgets every connection but keeps the call and the microphone (socket came back). */
  resetPeers(): void {
    for (const id of Array.from(this.peers.keys())) this.drop(id);
  }

  close(): void {
    this.generation += 1;
    this.resetPeers();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.muted = false;
    this.deafened = false;
    if (this.scope) this.kit.stopSession();
    this.scope = null;
    this.ready = false;
  }

  private ensure(id: string): Peer {
    const known = this.peers.get(id);
    if (known) return known;

    const pc = this.kit.createPeer();
    const peer: Peer = {
      id,
      pc,
      pending: [],
      queue: Promise.resolve(),
      remote: null,
      remoteFingerprint: '',
      stopPlaying: null,
      offered: false,
      restarts: 0,
      restartTimer: null,
    };
    this.peers.set(id, peer);
    this.setLink(id, 'connecting');

    const mic = this.mic;
    mic?.getAudioTracks().forEach((t) => pc.addTrack(t, mic));

    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.peers.get(id) === peer) {
        this.signal(id, { candidate: ev.candidate.toJSON() as WebRtcSignalPayload['candidate'] });
      }
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (!stream || this.peers.get(id) !== peer) return;
      peer.stopPlaying?.();
      peer.remote = stream;
      this.applyDeafened(peer);
      peer.stopPlaying = this.kit.play(stream);
    };
    pc.onconnectionstatechange = () => {
      if (this.peers.get(id) !== peer) return;
      if (pc.connectionState === 'connected') {
        peer.restarts = 0;
        this.setLink(id, 'connected');
      } else if (pc.connectionState === 'failed') {
        this.recover(peer);
      } else if (pc.connectionState !== 'closed') {
        this.setLink(id, 'connecting');
      }
    };
    return peer;
  }

  private offer(peer: Peer, iceRestart: boolean): void {
    peer.offered = true;
    // Without a microphone the offer still has to ask for the other voice.
    if (!this.mic && !iceRestart) peer.pc.addTransceiver('audio', { direction: 'recvonly' });
    peer.queue = peer.queue
      .then(async () => {
        const offer = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
        await peer.pc.setLocalDescription(offer);
        this.signalLocal(peer);
      })
      .catch(() => {
        peer.offered = false;
      });
  }

  private async applyDescription(peer: Peer, desc: RtcDescription): Promise<void> {
    if (this.peers.get(peer.id) !== peer) return;
    await peer.pc.setRemoteDescription(desc);
    while (peer.pending.length > 0) {
      await peer.pc.addIceCandidate(peer.pending.shift());
    }
    if (desc.type !== 'offer') return;
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    this.signalLocal(peer);
  }

  private async applyCandidate(peer: Peer, candidate: unknown): Promise<void> {
    if (this.peers.get(peer.id) !== peer) return;
    if (peer.pc.remoteDescription?.type) await peer.pc.addIceCandidate(candidate);
    else peer.pending.push(candidate);
  }

  // Networks change under a phone. Ask for a new route; the lower peerId asks
  // first and the other one only if that did not happen.
  private recover(peer: Peer): void {
    this.setLink(peer.id, 'failed');
    if (peer.restarts >= MAX_RESTARTS) return;
    peer.restarts += 1;
    if (peer.restartTimer) clearTimeout(peer.restartTimer);
    peer.restartTimer = setTimeout(
      () => {
        if (this.peers.get(peer.id) !== peer || peer.pc.connectionState !== 'failed') return;
        if (peer.pc.signalingState === 'stable') this.offer(peer, true);
      },
      this.selfPeerId < peer.id ? 300 : 5000
    );
  }

  private signalLocal(peer: Peer): void {
    const local = peer.pc.localDescription;
    if (local?.type && this.peers.get(peer.id) === peer) {
      this.signal(peer.id, { sdp: { type: local.type, sdp: local.sdp } });
    }
  }

  private signal(targetPeerId: string, signal: WebRtcSignalPayload): void {
    if (this.scope) this.send({ type: 'webrtc_signal', targetPeerId, scope: this.scope, signal });
  }

  private applyDeafened(peer: Peer): void {
    peer.remote?.getAudioTracks().forEach((t) => {
      t.enabled = !this.deafened;
    });
  }

  private drop(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    if (peer.restartTimer) clearTimeout(peer.restartTimer);
    peer.stopPlaying?.();
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    const { [id]: _gone, ...rest } = this.links;
    this.links = rest;
    this.onLinks(this.links);
  }

  private setLink(id: string, state: LinkState): void {
    if (this.links[id] === state) return;
    this.links = { ...this.links, [id]: state };
    this.onLinks(this.links);
  }
}

import type { WsInboundFrame } from '../types/canopy';

export type WebRtcSignalFrame = Extract<WsInboundFrame, { type: 'webrtc_signal' }>;

// The room socket hands call frames to the call without going through React
// state: a dropped or merged update would lose half a handshake.
const signalListeners = new Set<(frame: WebRtcSignalFrame) => void>();
const openListeners = new Set<(podId: string) => void>();

export function onWebRtcSignal(listener: (frame: WebRtcSignalFrame) => void): () => void {
  signalListeners.add(listener);
  return () => {
    signalListeners.delete(listener);
  };
}

export function emitWebRtcSignal(frame: WebRtcSignalFrame): void {
  signalListeners.forEach((l) => l(frame));
}

export function onSocketOpen(listener: (podId: string) => void): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

export function emitSocketOpen(podId: string): void {
  openListeners.forEach((l) => l(podId));
}

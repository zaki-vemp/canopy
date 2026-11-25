import type { RtcKit, RtcPeer, RtcStream } from './engine';
import { iceServers } from './ice';

export function loadKit(): RtcKit | null {
  if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return null;
  }
  return {
    createPeer: () =>
      new RTCPeerConnection({ iceServers: iceServers() }) as unknown as RtcPeer,

    getMic: async () =>
      (await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })) as unknown as RtcStream,

    play: (stream) => {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.srcObject = stream as unknown as MediaStream;
      document.body.appendChild(el);
      el.play().catch(() => {});
      return () => {
        el.srcObject = null;
        el.remove();
      };
    },

    startSession: () => {},
    stopSession: () => {},
    setSpeaker: () => {},
  };
}

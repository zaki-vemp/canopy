import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import type { RtcKit, RtcPeer, RtcStream } from './engine';
import { iceServers } from './ice';

// Expo Go carries no WebRTC, and importing the package there throws. null means
// calls need a Canopy build of the app.
export function loadKit(): RtcKit | null {
  if (!NativeModules.WebRTCModule || !NativeModules.InCallManager) return null;
  const rtc = require('react-native-webrtc') as typeof import('react-native-webrtc');
  const inCall = (
    require('react-native-incall-manager') as typeof import('react-native-incall-manager')
  ).default;

  return {
    createPeer: () =>
      new rtc.RTCPeerConnection({ iceServers: iceServers() }) as unknown as RtcPeer,

    getMic: async () =>
      (await rtc.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      })) as unknown as RtcStream,

    // Remote audio plays by itself on a phone.
    play: () => () => {},

    startSession: async () => {
      if (Platform.OS === 'android' && Number(Platform.Version) >= 31) {
        // Only for Bluetooth earphones. Refusing it keeps the speaker.
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
        ).catch(() => {});
      }
      // 'video' is the manager's word for "loudspeaker unless earphones are in".
      // It also holds the screen on: Android cuts the microphone in the background.
      // ponytail: add a microphone foreground service to keep talking with the app closed.
      inCall.start({ media: 'video' });
    },

    stopSession: () => inCall.stop(),

    setSpeaker: (on) => inCall.setForceSpeakerphoneOn(on),
  };
}

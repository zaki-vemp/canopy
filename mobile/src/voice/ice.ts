// STUN finds a direct route on most Wi-Fi. Phones behind a carrier's shared
// address need a TURN relay too; set the three EXPO_PUBLIC_TURN_* values to add one.
// ponytail: build-time TURN credentials; serve short-lived ones from the backend before a public release.
export function iceServers(): Array<{ urls: string | string[]; username?: string; credential?: string }> {
  const servers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  const turn = (process.env.EXPO_PUBLIC_TURN_URLS ?? '')
    .split(',')
    .map((u: string) => u.trim())
    .filter(Boolean);
  if (turn.length > 0) {
    servers.push({
      urls: turn,
      username: process.env.EXPO_PUBLIC_TURN_USERNAME ?? '',
      credential: process.env.EXPO_PUBLIC_TURN_CREDENTIAL ?? '',
    });
  }
  return servers;
}

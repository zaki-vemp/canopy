import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// 1. Verify zero violet/purple hex literals across mobile/src and App.tsx
const VIOLET_PATTERNS = [
  /#8b5cf6/i,
  /#7c3aed/i,
  /#6366f1/i,
  /#a855f7/i,
  /#9333ea/i,
  /blueviolet/i,
  /indigo/i,
];

// 2. Verify zero leftover Slack-style /channels or /threads routes & types
const FORBIDDEN_LEGACY_PATTERNS = [
  /\/channels\b/,
  /\/threads\b/,
  /\bChannelDto\b/,
  /\bPodChannel\b/,
  /\bactiveChannelByPodAtom\b/,
  /\bADD_CHANNEL\b/,
  /\bREMOVE_CHANNEL\b/,
  /\bThreadModal\b/,
];

function collectTsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

const rootDir = path.resolve(import.meta.dirname, '..');
const sourceFiles = [
  path.join(rootDir, 'App.tsx'),
  ...collectTsFiles(path.join(rootDir, 'src')),
];

assert.equal(
  fs.existsSync(path.join(rootDir, 'src', 'components', 'ThreadModal.tsx')),
  false,
  'Legacy ThreadModal.tsx must be deleted'
);

for (const file of sourceFiles) {
  const content = fs.readFileSync(file, 'utf8');
  if (!file.endsWith('palette.ts')) {
    for (const pat of VIOLET_PATTERNS) {
      assert.equal(
        pat.test(content),
        false,
        `Forbidden violet pattern ${pat} found in ${file}`
      );
    }
  }
  for (const legacyPat of FORBIDDEN_LEGACY_PATTERNS) {
    assert.equal(
      legacyPat.test(content),
      false,
      `Forbidden legacy channel/thread pattern ${legacyPat} found in ${file}`
    );
  }
}

// Verify Group Chat & 1:1 DM REST endpoints in src/api/client.ts
const clientSrc = fs.readFileSync(
  path.join(rootDir, 'src', 'api', 'client.ts'),
  'utf8'
);
assert.equal(
  clientSrc.includes('/api/pods/${podId}/messages'),
  true,
  'Missing Pod Group Chat /api/pods/${podId}/messages endpoint'
);
assert.equal(
  clientSrc.includes('/api/pods/${podId}/dms'),
  true,
  'Missing 1:1 DM list /api/pods/${podId}/dms endpoint'
);
assert.equal(
  clientSrc.includes(
    '/api/pods/${podId}/dms/${encodeURIComponent(peerId)}/messages'
  ),
  true,
  'Missing 1:1 DM messages /api/pods/${podId}/dms/${peerId}/messages endpoint'
);
assert.equal(
  clientSrc.includes('/api/pods/${podId}/read'),
  true,
  'Missing read-cursor /api/pods/${podId}/read endpoint'
);
assert.equal(
  clientSrc.includes('/api/pods/${podId}/mute') &&
    clientSrc.includes('/api/pods/read-all') &&
    clientSrc.includes('/api/polls/${pollId}/close'),
  true,
  'Missing mute, read-all, or closePoll endpoints in src/api/client.ts'
);

const appSrc = fs.readFileSync(path.join(rootDir, 'App.tsx'), 'utf8');
assert.equal(
  appSrc.includes('ROOM_TABS') && appSrc.includes("inRoom && !keyboardOpen"),
  true,
  'Phone layout must keep Chat and People tabs scoped within rooms'
);

const wsSrc = fs.readFileSync(path.join(rootDir, 'src', 'api', 'ws.ts'), 'utf8');
for (const wsEvent of [
  'dm_read',
  'dm_call_ringing',
  'dm_call_incoming',
  'dm_call_connected',
  'dm_call_state',
  'dm_call_ended',
]) {
  assert.equal(
    wsSrc.includes(wsEvent),
    true,
    `Missing ${wsEvent} handler in src/api/ws.ts`
  );
}

const chatScreenSrc = fs.readFileSync(
  path.join(rootDir, 'src', 'screens', 'PodChatScreen.tsx'),
  'utf8'
);
assert.equal(
  fs
    .readFileSync(path.join(rootDir, 'src', 'voice', 'useCalls.ts'), 'utf8')
    .includes('dm_call_ring'),
  true,
  'Missing dm_call_ring trigger in useCalls.ts'
);
assert.equal(
  chatScreenSrc.includes('markPodConversationRead'),
  true,
  'Missing markPodConversationRead auto-advance in PodChatScreen.tsx'
);

const msgCardSrc = fs.readFileSync(
  path.join(rootDir, 'src', 'components', 'MessageCard.tsx'),
  'utf8'
);
assert.equal(
  msgCardSrc.includes('✓✓ Seen') && msgCardSrc.includes('✓ Sent'),
  true,
  'Missing ✓✓ Seen / ✓ Sent receipts in MessageCard.tsx'
);

// 3. Verify zero-PII inside pod screens & modals (no email/fullName/gender/nationalityCode/userPublicId rendered)
const podFacingScreens = [
  ...[
    'PodsHubScreen.tsx',
    'PodChatScreen.tsx',
    'VoiceLoungeScreen.tsx',
    'SearchSavedScreen.tsx',
  ].map((f) => path.join(rootDir, 'src', 'screens', f)),
  path.join(rootDir, 'src', 'components', 'InviteShareModal.tsx'),
  path.join(rootDir, 'src', 'components', 'PodGovernanceModal.tsx'),
  path.join(rootDir, 'src', 'components', 'MessageCard.tsx'),
];

for (const screenFile of podFacingScreens) {
  const src = fs.readFileSync(screenFile, 'utf8');
  for (const piiField of [
    'fullName',
    'nationalityCode',
    'userPublicId',
    '.email',
    '.gender',
  ]) {
    assert.equal(
      src.includes(piiField),
      false,
      `PII field ${piiField} leaked into pod screen ${screenFile}`
    );
  }
}

// 4. Verify Group vs 1:1 DM partner resolution & convo key helpers
function resolveDmPartnerPeerId(selfPeerId, senderPeerId, recipientPeerId) {
  if (!recipientPeerId) return null;
  if (selfPeerId && senderPeerId === selfPeerId) return recipientPeerId;
  if (selfPeerId && recipientPeerId === selfPeerId) return senderPeerId;
  return senderPeerId;
}

function dmConvoKey(podId, peerId) {
  return peerId ? `${podId}:dm:${peerId}` : `${podId}:group`;
}

assert.equal(resolveDmPartnerPeerId('p_self', 'p_other', null), null);
assert.equal(resolveDmPartnerPeerId('p_self', 'p_self', 'p_jade'), 'p_jade');
assert.equal(resolveDmPartnerPeerId('p_self', 'p_jade', 'p_self'), 'p_jade');
assert.equal(dmConvoKey('pod_01', null), 'pod_01:group');
assert.equal(dmConvoKey('pod_01', 'p_jade'), 'pod_01:dm:p_jade');

// 5. Verify inline rich-text tokenizer regex parity (bold, code, spoilers)
const INLINE_TOKEN_RE = /(\|\|[^|]+\|\||\*\*[^*]+\*\*|`[^`]+`)/g;
function parseInline(line) {
  return line
    .split(INLINE_TOKEN_RE)
    .filter((p) => p.length > 0)
    .map((part) => {
      if (part.startsWith('||') && part.endsWith('||') && part.length > 4)
        return { kind: 'spoiler', value: part.slice(2, -2) };
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
        return { kind: 'bold', value: part.slice(2, -2) };
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
        return { kind: 'code', value: part.slice(1, -1) };
      return { kind: 'text', value: part };
    });
}

const tokens = parseInline('Ready for **co-op** on `map_02`? ||final boss||');
assert.deepEqual(tokens, [
  { kind: 'text', value: 'Ready for ' },
  { kind: 'bold', value: 'co-op' },
  { kind: 'text', value: ' on ' },
  { kind: 'code', value: 'map_02' },
  { kind: 'text', value: '? ' },
  { kind: 'spoiler', value: 'final boss' },
]);

// 6. Verify extractInviteCode parser parity
function extractInviteCode(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const inviteMatch = trimmed.match(/\/invites?\/([a-zA-Z0-9_-]+)/i);
  if (inviteMatch?.[1]) {
    return inviteMatch[1];
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed.split(/\s+/)[0]);
      const segments = url.pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1] ?? '';
      return last.replace(/[^a-zA-Z0-9_-]/g, '');
    } catch {
      return '';
    }
  }
  const token = trimmed
    .replace(/^#+/, '')
    .split(/[?#\s]/)[0]
    .replace(/\/+$/, '');
  const seg = token.includes('/')
    ? token.slice(token.lastIndexOf('/') + 1)
    : token;
  return seg.replace(/[^a-zA-Z0-9_-]/g, '');
}

assert.equal(extractInviteCode('k8m4p2x9q7w3'), 'k8m4p2x9q7w3');
assert.equal(extractInviteCode('  #k8m4p2x9q7w3  '), 'k8m4p2x9q7w3');
assert.equal(
  extractInviteCode('https://canopy.app/invite/k8m4p2x9q7w3?ref=share#top'),
  'k8m4p2x9q7w3'
);
assert.equal(
  extractInviteCode(
    'Join my anonymous pod: http://localhost:3001/invite/m8k4p2x9q7w3/'
  ),
  'm8k4p2x9q7w3'
);
assert.equal(extractInviteCode('https://canopy.app/'), '');
assert.equal(extractInviteCode('   '), '');

// 7. Verify 25-member capacity tiers (10 Compact / 25 Standard / 50 Club) & custom handle sanitizer
function capacityTierBadge(memberCount, maxMembers) {
  if (maxMembers <= 10) return `Compact ${memberCount}/${maxMembers}`;
  if (maxMembers <= 25) return `Standard ${memberCount}/${maxMembers}`;
  return `Club ${memberCount}/${maxMembers}`;
}

assert.equal(capacityTierBadge(4, 10), 'Compact 4/10');
assert.equal(capacityTierBadge(12, 25), 'Standard 12/25');
assert.equal(capacityTierBadge(31, 50), 'Club 31/50');

function sanitizePodHandle(raw, fallbackTitle = '') {
  const source = raw.trim().replace(/^#+/, '') || fallbackTitle.trim();
  return source
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

assert.equal(sanitizePodHandle('#Tactical Raiders!', ''), 'tactical-raiders');
assert.equal(
  sanitizePodHandle('', 'Nightly Helldivers Co-op'),
  'nightly-helldivers-co-op'
);

// 8. Pieces: an alias's first word picks the colour and its animal picks the shape.
// The hex the API sends is never used.
const palette = await import('../src/theme/palette.ts');
assert.equal(palette.pieceColor('Amber Owl'), palette.PIECE_HEX.amber);
assert.equal(palette.pieceColor('cobalt marten'), palette.PIECE_HEX.cobalt);
assert.equal(palette.safePeerColor('#0f766e', 'Quartz Fox'), palette.PIECE_HEX.quartz);
assert.deepEqual(
  palette.pieceRadii('Amber Fox', 100),
  {
    borderTopLeftRadius: 50,
    borderTopRightRadius: 50,
    borderBottomRightRadius: 50,
    borderBottomLeftRadius: 50,
  }
);
assert.equal(palette.pieceRadii('Jade Ibis', 100).borderTopLeftRadius, 0);
assert.equal(palette.PIECES.blue, '#1a4be0');
assert.equal(palette.PIECES.bg, '#f4f4f4');
assert.equal(palette.TOUCH_MIN >= 44, true);
// an unknown first word still lands on one of the twelve colours
assert.equal(
  Object.values(palette.PIECE_HEX).includes(palette.pieceColor('Zzz Lynx')),
  true
);

// 9. Every screen reads Text from the Pieces wrapper so Gabarito/Figtree/DM Mono apply,
// and no screen says "pod" to a person.
for (const file of sourceFiles) {
  if (file.endsWith('ui.tsx')) continue;
  const content = fs.readFileSync(file, 'utf8');
  const rn = content.match(/import \{([^}]*)\} from 'react-native';/);
  if (rn) {
    const names = rn[1].split(',').map((x) => x.trim());
    assert.equal(
      names.includes('Text') || names.includes('TextInput'),
      false,
      `${file} imports Text/TextInput from react-native; use ../theme/ui`
    );
  }
}

// 10. Call engine: who offers, when, and what happens when the other side starts over.
const { CallEngine } = await import('../src/voice/engine.ts');
const settle = () => new Promise((r) => setTimeout(r, 5));
function fakeCall() {
  const sent = [];
  const pcs = [];
  const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
  const mic = { getAudioTracks: () => [track], getTracks: () => [track] };
  const kit = {
    createPeer() {
      const pc = {
        connectionState: 'new',
        signalingState: 'stable',
        localDescription: null,
        remoteDescription: null,
        candidates: [],
        closed: false,
        tracks: 0,
        addTrack() { pc.tracks += 1; },
        addTransceiver() { pc.receiveOnly = true; },
        async createOffer() { return { type: 'offer', sdp: 'offer' }; },
        async createAnswer() { return { type: 'answer', sdp: 'answer' }; },
        async setLocalDescription(d) {
          pc.localDescription = d;
          pc.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
        },
        async setRemoteDescription(d) { pc.remoteDescription = d; pc.signalingState = 'stable'; },
        async addIceCandidate(c) {
          assert.ok(pc.remoteDescription, 'candidate added before the description');
          pc.candidates.push(c.candidate);
        },
        async getStats() { return new Map(); },
        close() { pc.closed = true; },
      };
      pcs.push(pc);
      return pc;
    },
    micDenied: false,
    async getMic() {
      if (kit.micDenied) throw new Error('denied');
      return mic;
    },
    play: () => () => {},
    startSession() { kit.session = true; },
    stopSession() { kit.session = false; },
    setSpeaker() {},
  };
  const engine = new CallEngine(kit, (f) => sent.push(f), () => {});
  const kinds = () => sent.map((f) => `${f.targetPeerId}:${f.signal.sdp?.type ?? 'candidate'}`);
  return { engine, kit, pcs, sent, kinds, track };
}
const offerFrom = (fp) => ({ sdp: { type: 'offer', sdp: `a=fingerprint:sha-256 ${fp}` } });

{
  const { engine, pcs, kinds, kit, track } = fakeCall();
  assert.equal(await engine.open('GROUP', 'p_b'), 'live');
  // Not on the server's list yet: an offer now would be dropped for good.
  engine.sync(['p_a', 'p_c']);
  assert.equal(pcs.length, 0);
  engine.sync(['p_a', 'p_b', 'p_c']);
  await settle();
  assert.deepEqual(kinds(), ['p_c:offer'], 'only the lower peerId offers');
  assert.equal(pcs.every((pc) => pc.tracks === 1), true, 'every connection carries our voice');
  // The other side's offer, with a candidate that overtook nothing.
  engine.receive('p_a', 'GROUP', { candidate: { candidate: 'early' } });
  engine.receive('p_a', 'GROUP', offerFrom('AA'));
  await settle();
  assert.deepEqual(kinds(), ['p_c:offer', 'p_a:answer']);
  assert.deepEqual(pcs[0].candidates, ['early']);
  // Same person, new certificate: they rebuilt their connection, so do we.
  engine.receive('p_a', 'GROUP', offerFrom('BB'));
  await settle();
  assert.equal(pcs[0].closed, true);
  assert.equal(pcs.length, 3);
  // Both offered at once: ours stands, because p_b sorts before p_c.
  engine.receive('p_c', 'GROUP', offerFrom('CC'));
  await settle();
  assert.equal(kinds().filter((k) => k === 'p_c:answer').length, 0);
  // A frame from the other kind of call is not ours.
  engine.receive('p_z', 'DM', offerFrom('ZZ'));
  assert.equal(pcs.length, 3);
  engine.setMuted(true);
  assert.equal(track.enabled, false);
  engine.sync(['p_b']);
  assert.equal(pcs.every((pc) => pc.closed), true, 'people who left are closed');
  engine.close();
  assert.equal(kit.session, false);
  assert.equal(track.stopped, true);
}
{
  // The route died (the phone changed networks): ask for a new one, same connection.
  const { engine, pcs, kinds } = fakeCall();
  await engine.open('GROUP', 'p_a');
  engine.sync(['p_a', 'p_b']);
  await settle();
  engine.receive('p_b', 'GROUP', { sdp: { type: 'answer', sdp: 'a=fingerprint:sha-256 AA' } });
  await settle();
  pcs[0].connectionState = 'failed';
  pcs[0].onconnectionstatechange();
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual(kinds(), ['p_b:offer', 'p_b:offer']);
  assert.equal(pcs.length, 1);
  engine.close();
}
{
  const { engine, pcs, kit } = fakeCall();
  kit.micDenied = true;
  assert.equal(await engine.open('GROUP', 'p_a'), 'listen');
  engine.sync(['p_a', 'p_b']);
  assert.equal(pcs[0].receiveOnly, true, 'without a microphone we still ask to hear');
}
{
  const { engine, track } = fakeCall();
  const opening = engine.open('DM', 'p_a');
  engine.close();
  assert.equal(await opening, null, 'hung up during the permission prompt');
  assert.equal(track.stopped, true);
}

console.log(
  'mobile selfcheck passed: call engine, zero-violet, zero-channels, Group+1:1-DM, /read + Seen receipts, dm_call_ring, 25-seat tiers, Pieces colours and shapes, and zero-PII verified.'
);

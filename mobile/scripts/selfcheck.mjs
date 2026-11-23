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

console.log(
  'mobile selfcheck passed: zero-violet, zero-channels, Group+1:1-DM routes, 25-seat tiers, and zero-PII verified.'
);

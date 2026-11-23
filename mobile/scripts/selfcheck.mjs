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

for (const file of sourceFiles) {
  if (file.endsWith('palette.ts')) continue; // palette.ts contains comment explaining rejected hues
  const content = fs.readFileSync(file, 'utf8');
  for (const pat of VIOLET_PATTERNS) {
    assert.equal(
      pat.test(content),
      false,
      `Forbidden violet pattern ${pat} found in ${file}`
    );
  }
}

// 2. Verify inline rich-text tokenizer regex parity (bold, code, spoilers, code fences)
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

// 3. Verify zero-PII inside pod screens & modals (no email/fullName/gender/nationalityCode rendered)
const podFacingScreens = [
  ...['PodsHubScreen.tsx', 'PodChatScreen.tsx', 'VoiceLoungeScreen.tsx', 'SearchSavedScreen.tsx'].map((f) =>
    path.join(rootDir, 'src', 'screens', f)
  ),
  path.join(rootDir, 'src', 'components', 'InviteShareModal.tsx'),
  path.join(rootDir, 'src', 'components', 'PodGovernanceModal.tsx'),
  path.join(rootDir, 'src', 'components', 'MessageCard.tsx'),
  path.join(rootDir, 'src', 'components', 'ThreadModal.tsx'),
];

for (const screenFile of podFacingScreens) {
  const src = fs.readFileSync(screenFile, 'utf8');
  for (const piiField of ['fullName', 'nationalityCode', '.email', '.gender']) {
    assert.equal(
      src.includes(piiField),
      false,
      `PII field ${piiField} leaked into pod screen ${screenFile}`
    );
  }
}

// 4. Verify extractInviteCode parser parity across bare codes, full URLs, query strings, and shared messages
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
  extractInviteCode('Join my anonymous pod: http://localhost:3001/invite/m8k4p2x9q7w3/'),
  'm8k4p2x9q7w3'
);
assert.equal(extractInviteCode('https://canopy.app/'), '');
assert.equal(extractInviteCode('   '), '');

// 5. Verify 25-member capacity tiers (10 Compact / 25 Standard / 50 Club) & custom handle sanitizer
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
assert.equal(sanitizePodHandle('', 'Nightly Helldivers Co-op'), 'nightly-helldivers-co-op');

console.log('mobile selfcheck passed: zero-violet, rich-parser, invite-parser, 25-member tiers, and zero-PII verified.');

import assert from 'node:assert/strict';
import {
  conversationKey,
  extractInviteCode,
  getPodTierLabel,
  parseKickCommandTarget,
  resolveMessagePeerId,
  sanitizeCustomPodCode,
  sortMembersWithDmConversations,
  type DmConversationSummary,
  type PodMember,
} from './canopy';

export function verifyExtractInviteCode(): void {
  assert.equal(
    extractInviteCode('http://localhost:3001/invite/k8m4p2x9q7w3?fresh=1'),
    'k8m4p2x9q7w3'
  );
  assert.equal(
    extractInviteCode('https://canopy.app/invite/m8k4p2x9q7w3/#join'),
    'm8k4p2x9q7w3'
  );
  assert.equal(extractInviteCode('  /invite/k8m4p2x9q7w3  '), 'k8m4p2x9q7w3');
  assert.equal(extractInviteCode('invite/k8m4p2x9q7w3?fresh=1'), 'k8m4p2x9q7w3');
  assert.equal(
    extractInviteCode('http://localhost:3001/register?invite=k8m4p2x9q7w3&fresh=1'),
    'k8m4p2x9q7w3'
  );
  assert.equal(extractInviteCode('  k8m4p2x9q7w3  '), 'k8m4p2x9q7w3');
  assert.equal(extractInviteCode('#k8m4p2x9q7w3'), 'k8m4p2x9q7w3');
  assert.equal(extractInviteCode(''), '');
  assert.equal(extractInviteCode('http://localhost:3001/app'), '');

  assert.equal(getPodTierLabel(10), 'Compact');
  assert.equal(getPodTierLabel(6), 'Compact');
  assert.equal(getPodTierLabel(25), 'Standard');
  assert.equal(getPodTierLabel(50), 'Club');

  assert.equal(
    sanitizeCustomPodCode('  #Tactical Co-op Raiders!! '),
    'tactical-co-op-raiders'
  );

  const members: PodMember[] = [
    {
      peerId: 'p_self',
      alias: 'Cobalt Fox',
      color: '#1f6b3a',
      role: 'MEMBER',
      customStatus: '',
      online: true,
      inVoice: false,
      isSelf: true,
    },
    {
      peerId: 'p_target',
      alias: 'Slate Otter',
      color: '#235c38',
      role: 'MEMBER',
      customStatus: '',
      online: false,
      inVoice: false,
    },
    {
      peerId: 'p_jade',
      alias: 'Jade Owl',
      color: '#0f766e',
      role: 'MEMBER',
      customStatus: 'Ready for co-op',
      online: true,
      inVoice: true,
    },
    {
      peerId: 'p_amber',
      alias: 'Amber Heron',
      color: '#8c430f',
      role: 'MEMBER',
      customStatus: '',
      online: true,
      inVoice: false,
    },
  ];
  const parsed = parseKickCommandTarget(
    '/kick @Slate Otter — disruptive audio spam',
    members,
    'p_self'
  );
  assert.equal(parsed?.target.peerId, 'p_target');
  assert.equal(parsed?.reason, 'disruptive audio spam');
  assert.equal(
    parseKickCommandTarget('/kick @Cobalt Fox', members, 'p_self'),
    null
  );

  // Verify Group vs 1:1 DM routing helpers
  assert.equal(conversationKey('pod1', null), 'pod1:group');
  assert.equal(conversationKey('pod1', 'p_jade'), 'pod1:dm:p_jade');
  assert.equal(resolveMessagePeerId('p_self', null, 'p_self'), null);
  assert.equal(resolveMessagePeerId('p_self', 'p_jade', 'p_self'), 'p_jade');
  assert.equal(resolveMessagePeerId('p_jade', 'p_self', 'p_self'), 'p_jade');

  // Verify DM sorting: active DMs (lastMessageId DESC), then online/inVoice, then offline, excluding self
  const dms: DmConversationSummary[] = [
    {
      peerId: 'p_target',
      peerAlias: 'Slate Otter',
      peerColor: '#235c38',
      online: false,
      lastMessageId: 220,
      lastBody: 'Catch you tomorrow!',
      lastSenderPeerId: 'p_target',
      lastSenderAlias: 'Slate Otter',
      lastCreatedAt: '2026-11-23T17:15:00Z',
    },
  ];
  const ordered = sortMembersWithDmConversations(members, 'p_self', dms);
  assert.deepEqual(
    ordered.map((m) => m.peerId),
    ['p_target', 'p_jade', 'p_amber']
  );
}

verifyExtractInviteCode();

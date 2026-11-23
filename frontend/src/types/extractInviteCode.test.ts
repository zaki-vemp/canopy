import assert from 'node:assert/strict';
import {
  extractInviteCode,
  getPodTierLabel,
  parseKickCommandTarget,
  sanitizeCustomPodCode,
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
      voiceChannelId: null,
    },
    {
      peerId: 'p_target',
      alias: 'Slate Otter',
      color: '#235c38',
      role: 'MEMBER',
      customStatus: '',
      online: true,
      voiceChannelId: null,
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
}

verifyExtractInviteCode();

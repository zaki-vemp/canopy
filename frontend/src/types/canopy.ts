export type PlanTier = 'FREE' | 'PREMIUM';

export interface SelfUser {
  userId: string;
  email: string;
  fullName: string;
  gender: string;
  nationalityCode: string;
  planTier: PlanTier;
}

export interface InterestItem {
  slug: string;
  label: string;
  category: string;
  openPods: number;
  activeMembers: number;
  selected: boolean;
}

export type PodMemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export type PodGovernanceMode = 'DEMOCRATIC' | 'ADMIN';

export interface PodMember {
  peerId: string;
  alias: string;
  color: string;
  role: PodMemberRole;
  customStatus: string;
  online: boolean;
  inVoice: boolean;
  isSelf?: boolean;
}

export interface DmConversationSummary {
  peerId: string;
  peerAlias: string;
  peerColor: string;
  online: boolean;
  lastMessageId: number;
  lastBody: string;
  lastSenderPeerId: string;
  lastSenderAlias: string;
  lastCreatedAt: string;
}

export type PodCapacityPreset = null | 10 | 25 | 50;

export interface MatchRequest {
  interest: string;
  matchAll: boolean;
  maxMembers?: PodCapacityPreset;
  forceNewPod?: boolean;
  allowAdditional?: boolean;
}

export interface LeavePodRequest {
  rematch: boolean;
  maxMembers?: PodCapacityPreset;
  forceNewPod?: boolean;
}

export function getPodTierLabel(
  maxMembers: number
): 'Compact' | 'Standard' | 'Club' {
  if (maxMembers <= 10) return 'Compact';
  if (maxMembers <= 25) return 'Standard';
  return 'Club';
}

export interface PodDetail {
  podId: string;
  code: string;
  title: string;
  description: string;
  interestSlug: string;
  interestLabel: string;
  governanceMode: PodGovernanceMode;
  isPublicized: boolean;
  allowRandomMatch: boolean;
  isOpen?: boolean;
  myPeerId: string;
  myAlias: string;
  myColor: string;
  myRole: PodMemberRole;
  myStatus: string;
  memberCount: number;
  maxMembers: number;
  openProposalsCount: number;
  dmConversations?: DmConversationSummary[];
  members: PodMember[];
}

export type ProposalKind =
  | 'KICK_MEMBER'
  | 'RENAME_POD'
  | 'UPDATE_TOPIC'
  | 'CHANGE_CAPACITY'
  | 'TOGGLE_LOCK'
  | 'PIN_MESSAGE';

export type ProposalStatus = 'OPEN' | 'PASSED' | 'REJECTED';

export interface PodProposalDto {
  id: number;
  podId: string;
  kind: ProposalKind;
  title: string;
  reason: string;
  proposerAlias: string;
  targetPeerId: string | null;
  targetAlias: string | null;
  status: ProposalStatus;
  yesCount: number;
  noCount: number;
  eligibleCount: number;
  yesAliases: string[];
  noAliases: string[];
  myVote: boolean | null;
  expiresAt: string;
  resolvedAt: string | null;
  createdAt: string;
}

export interface CreateProposalRequest {
  kind: ProposalKind;
  targetPeerId?: string;
  label?: string;
  title?: string;
  topic?: string;
  description?: string;
  maxMembers?: 10 | 25 | 50;
  locked?: boolean;
  messageId?: number;
  reason?: string;
  expiresInMinutes?: number;
}

export interface PublicizedPodDto {
  podId: string;
  code: string;
  title: string;
  description: string;
  interestSlug: string;
  interestLabel: string;
  founderAlias: string;
  memberCount: number;
  maxMembers: number;
  alreadyMember: boolean;
}

export interface CreateCustomPodRequest {
  title: string;
  code: string;
  interest: string;
  description: string;
  maxMembers: 10 | 25 | 50;
  isPublicized: boolean;
}

export interface UpdatePodSettingsRequest {
  title: string;
  description: string;
  maxMembers: 10 | 25 | 50;
  isPublicized: boolean;
  isOpen: boolean;
}

export interface PodInviteDto {
  code: string;
  podId: string;
  podCode: string;
  podTitle?: string;
  governanceMode?: PodGovernanceMode;
  interestSlug: string;
  interestLabel: string;
  invitedByAlias: string;
  memberCount: number;
  maxMembers: number;
  maxUses: number;
  usesCount: number;
  expiresAt: string | null;
  createdAt: string;
  isExpired: boolean;
  isRevoked: boolean;
  isFull: boolean;
  canAccept: boolean;
}

export interface CreateInviteRequest {
  maxUses?: number;
  expiresInHours?: number;
  regenerate?: boolean;
}

export interface AcceptInviteResponse {
  alreadyMember: boolean;
  pod: PodDetail;
  pods: PodDetail[];
}

export function extractInviteCode(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) return '';
  const pathMatch = /\/invite\/([A-Za-z0-9_-]+)/i.exec(trimmed);
  if (pathMatch) return pathMatch[1];
  const queryMatch = /[?&]invite=([A-Za-z0-9_-]+)/i.exec(trimmed);
  if (queryMatch) return queryMatch[1];
  const bare = trimmed
    .replace(/^#/, '')
    .replace(/^invite\//i, '')
    .split(/[?#/\s]/)[0];
  return /^[A-Za-z0-9_-]+$/.test(bare) ? bare : '';
}

export function sanitizeCustomPodCode(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function parseKickCommandTarget(
  rawBody: string,
  members: PodMember[],
  selfPeerId: string
): { target: PodMember; reason: string } | null {
  const trimmed = rawBody.trim();
  if (!/^\/kick(?:\s+|$)/i.test(trimmed)) return null;
  const rest = trimmed.replace(/^\/kick\s*/i, '').replace(/^@+/, '').trim();
  if (!rest) return null;
  const restLower = rest.toLowerCase();
  const candidates = members
    .filter((m) => m.peerId !== selfPeerId)
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const member of candidates) {
    const aliasLower = member.alias.toLowerCase();
    if (
      restLower === aliasLower ||
      restLower.startsWith(`${aliasLower} `) ||
      restLower.startsWith(`${aliasLower}:`) ||
      restLower.startsWith(`${aliasLower} -`)
    ) {
      const reason = rest
        .slice(member.alias.length)
        .replace(/^[\s:—–-]+/, '')
        .trim();
      return { target: member, reason };
    }
  }
  return null;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  aliases: string[];
  meReacted: boolean;
}

export interface AttachmentItem {
  id: number;
  kind: 'image' | 'file' | 'voice_note' | string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number;
  url: string;
}

export interface PollOption {
  index: number;
  label: string;
  votes: number;
  voters: string[];
  meVoted: boolean;
}

export interface PollData {
  pollId: number;
  question: string;
  isClosed: boolean;
  options: PollOption[];
}

export type MessageKind =
  | 'TEXT'
  | 'SYSTEM'
  | 'POLL'
  | 'VOICE_NOTE'
  | 'ICEBREAKER'
  | 'GOVERNANCE';

export interface QuotedMessage {
  id: number;
  senderPeerId?: string;
  senderAlias: string;
  senderColor?: string;
  body: string;
  msgType?: MessageKind;
  isDeleted?: boolean;
}

export interface RichMessage {
  id: number;
  podId: string;
  senderPeerId: string;
  senderAlias: string;
  senderColor: string;
  recipientPeerId: string | null;
  recipientAlias: string | null;
  quoteMessage: QuotedMessage | null;
  msgType: MessageKind;
  body: string;
  isPinned: boolean;
  isBookmarked: boolean;
  isDeleted: boolean;
  editedAt: string | null;
  createdAt: string;
  reactions: ReactionSummary[];
  attachments: AttachmentItem[];
  poll: PollData | null;
  proposal?: PodProposalDto | null;
}

export interface MessagesPage {
  messages: RichMessage[];
  nextBeforeId: number;
}

export interface PostMessageResponse {
  message?: RichMessage | null;
  commandHandled?: string | null;
}

export function conversationKey(podId: string, peerId: string | null): string {
  return peerId ? `${podId}:dm:${peerId}` : `${podId}:group`;
}

export function resolveMessagePeerId(
  senderPeerId: string,
  recipientPeerId: string | null | undefined,
  myPeerId: string
): string | null {
  if (!recipientPeerId) return null;
  return senderPeerId === myPeerId ? recipientPeerId : senderPeerId;
}

export function messageQueryKey(
  podId: string,
  peerId: string | null
): readonly ['messages', string, 'group'] | readonly ['messages', string, 'dm', string] {
  return peerId
    ? (['messages', podId, 'dm', peerId] as const)
    : (['messages', podId, 'group'] as const);
}

export function deriveDmPreviewBody(
  msg: Pick<RichMessage, 'body' | 'attachments' | 'isDeleted'>
): string {
  if (msg.isDeleted) return 'Message deleted';
  const trimmed = msg.body.trim();
  if (trimmed) return trimmed;
  if (
    msg.attachments.some(
      (a) => a.kind === 'voice_note' || a.mimeType.startsWith('audio/')
    )
  ) {
    return 'Sent a voice note';
  }
  if (msg.attachments.some((a) => a.kind === 'image' || a.mimeType.startsWith('image/'))) {
    return 'Sent a photo';
  }
  if (msg.attachments.length > 0) {
    return 'Sent an attachment';
  }
  return '';
}

export function sortMembersWithDmConversations(
  members: PodMember[],
  myPeerId: string,
  dmConversations: DmConversationSummary[] = []
): PodMember[] {
  const dmByPeer = new Map<string, DmConversationSummary>();
  for (const dm of dmConversations) {
    dmByPeer.set(dm.peerId, dm);
  }
  return members
    .filter((m) => !m.isSelf && m.peerId !== myPeerId)
    .sort((a, b) => {
      const dmA = dmByPeer.get(a.peerId);
      const dmB = dmByPeer.get(b.peerId);
      if (dmA && dmB) return dmB.lastMessageId - dmA.lastMessageId;
      if (dmA) return -1;
      if (dmB) return 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      if (a.inVoice !== b.inVoice) return a.inVoice ? -1 : 1;
      return a.alias.localeCompare(b.alias);
    });
}

export interface VoicePeer {
  peerId: string;
  alias: string;
  color: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
}

export interface WebRtcSignalPayload {
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export type WsOutboundFrame =
  | { type: 'typing'; targetPeerId: string | null; isTyping: boolean }
  | {
      type: 'voice_join';
      muted: boolean;
      deafened: boolean;
    }
  | { type: 'voice_leave' }
  | {
      type: 'voice_state';
      muted: boolean;
      deafened: boolean;
      speaking: boolean;
    }
  | {
      type: 'webrtc_signal';
      targetPeerId: string;
      signal: WebRtcSignalPayload;
    }
  | { type: 'ping' };

export type WsInboundFrame =
  | {
      type: 'presence_snapshot';
      podId: string;
      selfPeerId: string;
      onlinePeerIds: string[];
      members: PodMember[];
      voicePeers: VoicePeer[];
    }
  | {
      type: 'typing_update';
      targetPeerId: string | null;
      fromPeerId: string | null;
      typingAliases: string[];
    }
  | {
      type: 'message_created';
      message: RichMessage;
    }
  | {
      type: 'message_updated';
      message: RichMessage;
    }
  | {
      type: 'message_deleted';
      messageId: number;
      senderPeerId: string;
      recipientPeerId: string | null;
    }
  | {
      type: 'reaction_updated';
      message: RichMessage;
    }
  | {
      type: 'pin_updated';
      message: RichMessage;
    }
  | {
      type: 'poll_updated';
      message: RichMessage;
    }
  | {
      type: 'member_joined';
      member: PodMember;
    }
  | {
      type: 'member_left';
      peerId: string;
      alias: string;
    }
  | {
      type: 'member_kicked';
      peerId: string;
      alias: string;
    }
  | {
      type: 'proposal_updated';
      proposal: PodProposalDto;
    }
  | {
      type: 'pod_updated';
      pod: PodDetail;
    }
  | {
      type: 'voice_roster_updated';
      voicePeers: VoicePeer[];
    }
  | {
      type: 'webrtc_signal';
      fromPeerId: string;
      fromAlias: string;
      signal: WebRtcSignalPayload;
    }
  | {
      type: 'pong';
    };

export type RightPanelMode =
  | 'members'
  | 'votes'
  | 'pins'
  | 'bookmarks'
  | 'search'
  | null;

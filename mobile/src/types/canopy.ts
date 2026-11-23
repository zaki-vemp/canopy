export type PlanTier = 'FREE' | 'PREMIUM';

export interface SelfUser {
  userId: string;
  email: string;
  fullName: string;
  gender: string;
  nationalityCode: string;
  planTier: PlanTier;
}

export interface AuthResponse {
  token: string;
  user: SelfUser;
}

export interface InterestItem {
  slug: string;
  label: string;
  category: string;
  openPods: number;
  activeMembers: number;
  selected: boolean;
}

export type PodGovernanceMode = 'DEMOCRATIC' | 'ADMIN';
export type PodMemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type PodCapacityPreset = 10 | 25 | 50;

export interface MemberDto {
  peerId: string;
  alias: string;
  color: string;
  role?: PodMemberRole;
  customStatus: string;
  online: boolean;
  inVoice: boolean;
  isSelf?: boolean;
}
export type PodMember = MemberDto;

export interface DmSummaryDto {
  peerId: string;
  peerAlias: string;
  peerColor: string;
  online: boolean;
  lastMessageId: number;
  lastBody: string;
  lastSenderPeerId: string;
  lastSenderAlias: string;
  lastCreatedAt: string;
  unreadCount?: number;
  peerLastReadMessageId?: number;
}

export interface PodDetailDto {
  podId: string;
  code: string;
  title: string;
  description: string;
  interestSlug: string;
  interestLabel: string;
  governanceMode: PodGovernanceMode;
  isPublicized: boolean;
  allowRandomMatch?: boolean;
  isOpen?: boolean;
  myPeerId: string;
  myAlias: string;
  myColor: string;
  myRole: PodMemberRole;
  myStatus: string;
  memberCount: number;
  maxMembers: number;
  openProposalsCount: number;
  unreadGroupCount?: number;
  dmConversations: DmSummaryDto[];
  members: MemberDto[];
}
export type PodDetail = PodDetailDto;

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
  targetPeerId?: string | null;
  targetAlias?: string | null;
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
  topic?: string;
  maxMembers?: number;
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
  code?: string;
  interest: string;
  description?: string;
  maxMembers: PodCapacityPreset;
  isPublicized: boolean;
}

export interface UpdatePodSettingsRequest {
  title?: string;
  description?: string;
  maxMembers?: PodCapacityPreset;
  isPublicized?: boolean;
  isOpen?: boolean;
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

export interface RichMessageDto {
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
export type RichMessage = RichMessageDto;

export interface MessagesPage {
  messages: RichMessageDto[];
  nextBeforeId: number;
}

export interface PostMessageResponse {
  message?: RichMessageDto | null;
  commandHandled?: string | null;
}

export interface MatchPodsRequest {
  interest?: string;
  matchAll?: boolean;
  maxMembers?: PodCapacityPreset | null;
  forceNewPod?: boolean;
  allowAdditional?: boolean;
}

export interface MatchPodsResponse {
  matched: PodDetailDto[];
  pods: PodDetailDto[];
}

export interface LeavePodRequest {
  rematch?: boolean;
  maxMembers?: PodCapacityPreset | null;
  forceNewPod?: boolean;
}

export interface LeavePodResponse {
  leftPodId: string;
  newPod: PodDetailDto | null;
}

export interface PodInviteDto {
  code: string;
  podId: string;
  podCode: string;
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
  pod: PodDetailDto;
  pods: PodDetailDto[];
}

export function extractInviteCode(raw: string): string {
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

export function resolveDmPartnerPeerId(
  selfPeerId: string | null | undefined,
  senderPeerId: string,
  recipientPeerId: string | null | undefined
): string | null {
  if (!recipientPeerId) return null;
  if (selfPeerId && senderPeerId === selfPeerId) return recipientPeerId;
  if (selfPeerId && recipientPeerId === selfPeerId) return senderPeerId;
  return senderPeerId;
}

export interface VoicePeerDto {
  peerId: string;
  alias: string;
  color: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
}
export type VoicePeer = VoicePeerDto;

export interface RtcSdpSignal {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback' | string;
  sdp?: string;
}

export interface RtcIceCandidateSignal {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface WebRtcSignalPayload {
  sdp?: RtcSdpSignal;
  candidate?: RtcIceCandidateSignal;
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
  | { type: 'dm_call_ring'; targetPeerId: string }
  | { type: 'dm_call_accept'; callerPeerId: string }
  | { type: 'dm_call_decline'; callerPeerId: string }
  | { type: 'dm_call_end'; peerId: string }
  | {
      type: 'dm_call_state';
      peerId: string;
      muted: boolean;
      speaking: boolean;
    }
  | {
      type: 'webrtc_signal';
      targetPeerId: string;
      scope?: 'GROUP' | 'DM';
      signal: WebRtcSignalPayload;
    }
  | { type: 'ping' };

export type WsInboundFrame =
  | {
      type: 'presence_snapshot';
      podId: string;
      selfPeerId: string;
      onlinePeerIds: string[];
      members: MemberDto[];
      voicePeers: VoicePeerDto[];
    }
  | {
      type: 'typing_update';
      targetPeerId: string | null;
      fromPeerId: string | null;
      typingAliases: string[];
    }
  | {
      type: 'message_created';
      message: RichMessageDto;
    }
  | {
      type: 'message_updated';
      message: RichMessageDto;
    }
  | {
      type: 'message_deleted';
      messageId: number;
      senderPeerId: string;
      recipientPeerId: string | null;
    }
  | {
      type: 'reaction_updated';
      message: RichMessageDto;
    }
  | {
      type: 'pin_updated';
      message: RichMessageDto;
    }
  | {
      type: 'poll_updated';
      message: RichMessageDto;
    }
  | {
      type: 'dm_read';
      peerId: string;
      targetPeerId: string;
      lastReadMessageId: number;
    }
  | {
      type: 'dm_call_ringing';
      targetPeerId: string;
      targetAlias: string;
      targetColor: string;
      targetOnline: boolean;
    }
  | {
      type: 'dm_call_incoming';
      fromPeerId: string;
      fromAlias: string;
      fromColor: string;
    }
  | {
      type: 'dm_call_connected';
      peerAId: string;
      peerAAlias: string;
      peerBId: string;
      peerBAlias: string;
    }
  | {
      type: 'dm_call_state';
      fromPeerId: string;
      muted: boolean;
      speaking: boolean;
    }
  | {
      type: 'dm_call_ended';
      byPeerId: string;
      reason: 'ended' | 'declined' | 'disconnected' | string;
    }
  | {
      type: 'proposal_updated';
      proposal: PodProposalDto;
    }
  | {
      type: 'pod_updated';
      pod: PodDetailDto;
    }
  | {
      type: 'member_joined';
      member: MemberDto;
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
      type: 'voice_roster_updated';
      voicePeers: VoicePeerDto[];
    }
  | {
      type: 'webrtc_signal';
      fromPeerId: string;
      fromAlias: string;
      scope?: 'GROUP' | 'DM';
      signal: WebRtcSignalPayload;
    }
  | { type: 'pong' };

export function sanitizePodHandle(raw: string, fallbackTitle = ''): string {
  const source = raw.trim().replace(/^#+/, '') || fallbackTitle.trim();
  return source
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

export type MobileTabKey = 'pods' | 'chat' | 'voice' | 'search' | 'account';

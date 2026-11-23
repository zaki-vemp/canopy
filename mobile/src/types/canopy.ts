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

export type ChannelKind = 'TEXT' | 'VOICE';
export type PodGovernanceMode = 'DEMOCRATIC' | 'ADMIN';
export type PodMemberRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type PodCapacityPreset = 10 | 25 | 50;

export interface PodChannel {
  channelId: string;
  slug: string;
  label: string;
  topic: string;
  kind: ChannelKind;
  position: number;
}

export interface PodMember {
  peerId: string;
  alias: string;
  color: string;
  role?: PodMemberRole;
  customStatus: string;
  online: boolean;
  voiceChannelId: string | null;
  isSelf?: boolean;
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
  allowRandomMatch?: boolean;
  myPeerId: string;
  myAlias: string;
  myColor: string;
  myRole: PodMemberRole;
  myStatus: string;
  memberCount: number;
  maxMembers: number;
  openProposalsCount: number;
  channels: PodChannel[];
  members: PodMember[];
}

export type ProposalKind =
  | 'KICK_MEMBER'
  | 'ADD_CHANNEL'
  | 'REMOVE_CHANNEL'
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
  channelId?: string;
  label?: string;
  topic?: string;
  channelKind?: ChannelKind;
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

export interface RichMessage {
  id: number;
  podId: string;
  channelId: string;
  senderPeerId: string;
  senderAlias: string;
  senderColor: string;
  parentMessageId: number;
  quoteMessage: QuotedMessage | null;
  msgType: MessageKind;
  body: string;
  replyCount: number;
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

export interface ThreadPayload {
  parent: RichMessage;
  replies: RichMessage[];
}

export interface PostMessageResponse {
  message?: RichMessage;
  commandHandled?: string;
}

export interface MatchPodsRequest {
  interest?: string;
  matchAll?: boolean;
  maxMembers?: PodCapacityPreset | null;
  forceNewPod?: boolean;
  allowAdditional?: boolean;
}

export interface MatchPodsResponse {
  matched: PodDetail[];
  pods: PodDetail[];
}

export interface LeavePodRequest {
  rematch?: boolean;
  maxMembers?: PodCapacityPreset | null;
  forceNewPod?: boolean;
}

export interface LeavePodResponse {
  leftPodId: string;
  newPod: PodDetail | null;
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
  pod: PodDetail;
  pods: PodDetail[];
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

export interface VoicePeer {
  peerId: string;
  alias: string;
  color: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
}

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
  | { type: 'typing'; channelId: string; isTyping: boolean }
  | {
      type: 'voice_join';
      voiceChannelId: string;
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
      voiceChannelId: string;
      signal: WebRtcSignalPayload;
    };

export type WsInboundFrame =
  | {
      type: 'presence_snapshot';
      podId: string;
      selfPeerId: string;
      onlinePeerIds: string[];
      members: PodMember[];
      voiceRoster: Record<string, VoicePeer[]>;
    }
  | {
      type: 'typing_update';
      channelId: string;
      typingAliases: string[];
    }
  | {
      type: 'message_created';
      channelId: string;
      message: RichMessage;
    }
  | {
      type: 'thread_reply_created';
      channelId: string;
      parentMessageId: number;
      reply: RichMessage;
      parentReplyCount: number;
    }
  | {
      type: 'message_updated';
      channelId: string;
      message: RichMessage;
    }
  | {
      type: 'message_deleted';
      channelId: string;
      messageId: number;
      parentMessageId: number;
    }
  | {
      type: 'reaction_updated';
      channelId: string;
      message: RichMessage;
    }
  | {
      type: 'pin_updated';
      channelId: string;
      message: RichMessage;
    }
  | {
      type: 'poll_updated';
      channelId: string;
      message: RichMessage;
    }
  | {
      type: 'channel_created';
      channel: PodChannel;
    }
  | {
      type: 'channel_deleted';
      channelId: string;
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
      type: 'voice_roster_updated';
      voiceRoster: Record<string, VoicePeer[]>;
    }
  | {
      type: 'webrtc_signal';
      voiceChannelId: string;
      fromPeerId: string;
      fromAlias: string;
      signal: WebRtcSignalPayload;
    };

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

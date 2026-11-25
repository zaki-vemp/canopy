import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type {
  AcceptInviteResponse,
  AttachmentItem,
  AuthResponse,
  CreateCustomPodRequest,
  CreateInviteRequest,
  CreateProposalRequest,
  DmSummaryDto,
  InterestItem,
  LeavePodRequest,
  LeavePodResponse,
  MatchPodsRequest,
  MatchPodsResponse,
  MessagesPage,
  PlanTier,
  PodDetailDto,
  PodInviteDto,
  PodMemberRole,
  PodProposalDto,
  PostMessageResponse,
  PublicizedPodDto,
  RichMessageDto,
  SelfUser,
  UpdatePodSettingsRequest,
} from '../types/canopy';

export const JWT_STORAGE_KEY = 'canopy_mobile_jwt';
export const API_URL_STORAGE_KEY = 'canopy_mobile_api_url';

export function getDefaultApiBaseUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (envUrl) {
    return envUrl.replace(/\/+$/, '');
  }
  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:8090';
  }
  return 'http://localhost:8090';
}

let currentToken: string | null = null;
let currentApiBaseUrl: string = getDefaultApiBaseUrl();

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return getDefaultApiBaseUrl();
  if (!/^https?:\/\//i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

export async function hydrateClientStorage(): Promise<{
  token: string | null;
  apiBaseUrl: string;
}> {
  try {
    const [storedToken, storedApiUrl] = await Promise.all([
      AsyncStorage.getItem(JWT_STORAGE_KEY),
      AsyncStorage.getItem(API_URL_STORAGE_KEY),
    ]);
    currentToken = storedToken || null;
    currentApiBaseUrl = storedApiUrl
      ? normalizeBaseUrl(storedApiUrl)
      : getDefaultApiBaseUrl();
  } catch {
    currentToken = null;
    currentApiBaseUrl = getDefaultApiBaseUrl();
  }
  return { token: currentToken, apiBaseUrl: currentApiBaseUrl };
}

export function getAuthToken(): string | null {
  return currentToken;
}

export async function setStoredToken(token: string): Promise<void> {
  currentToken = token;
  await AsyncStorage.setItem(JWT_STORAGE_KEY, token);
}

export async function clearStoredToken(): Promise<void> {
  currentToken = null;
  await AsyncStorage.removeItem(JWT_STORAGE_KEY);
}

export function getApiBaseUrl(): string {
  return currentApiBaseUrl;
}

export async function setStoredApiBaseUrl(rawUrl: string): Promise<string> {
  const normalized = normalizeBaseUrl(rawUrl);
  currentApiBaseUrl = normalized;
  await AsyncStorage.setItem(API_URL_STORAGE_KEY, normalized);
  return normalized;
}

export async function resetStoredApiBaseUrl(): Promise<string> {
  const def = getDefaultApiBaseUrl();
  currentApiBaseUrl = def;
  await AsyncStorage.removeItem(API_URL_STORAGE_KEY);
  return def;
}

export function getWsBaseUrl(): string {
  const base = getApiBaseUrl();
  if (base.startsWith('https://')) {
    return `wss://${base.slice('https://'.length)}`;
  }
  if (base.startsWith('http://')) {
    return `ws://${base.slice('http://'.length)}`;
  }
  return `ws://${base}`;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value: string, key: string) => {
        headers[key] = value;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        headers[key] = value;
      }
    } else {
      Object.assign(headers, init.headers);
    }
  }

  if (currentToken && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${currentToken}`;
  }
  if (
    init.body &&
    typeof init.body === 'string' &&
    !headers['Content-Type']
  ) {
    headers['Content-Type'] = 'application/json';
  }

  const url = path.startsWith('http') ? path : `${currentApiBaseUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Network error';
    throw new ApiError(
      0,
      `Cannot reach ${currentApiBaseUrl} (${detail}). Check Server URL in settings.`
    );
  }

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const errJson = (await res.json()) as {
        error?: string;
        message?: string;
      };
      msg = errJson.error || errJson.message || msg;
    } catch {
      // ignore non-JSON body
    }
    throw new ApiError(res.status, msg);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export function buildAttachmentUrl(pathOrUrl: string): string {
  const base = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${currentApiBaseUrl}${pathOrUrl}`;
  if (!currentToken) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(currentToken)}`;
}

// --- Auth & Private Profile ---

export async function registerAccount(payload: {
  email: string;
  password: string;
  fullName: string;
  gender: string;
  nationalityCode: string;
}): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/api/auth/register?tabOnly=true', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function loginAccount(payload: {
  email: string;
  password: string;
}): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/api/auth/login?tabOnly=true', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function logoutAccount(): Promise<void> {
  try {
    await apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
  } catch {
    // ignore network failure during sign-out
  }
}

export async function fetchMe(): Promise<{ user: SelfUser }> {
  return apiFetch<{ user: SelfUser }>('/api/auth/me');
}

export async function updateMe(payload: {
  fullName: string;
  gender: string;
  nationalityCode: string;
}): Promise<{ user: SelfUser }> {
  return apiFetch<{ user: SelfUser }>('/api/auth/me', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function updatePlanTier(
  planTier: PlanTier
): Promise<{ user: SelfUser }> {
  return apiFetch<{ user: SelfUser }>('/api/auth/plan', {
    method: 'POST',
    body: JSON.stringify({ planTier }),
  });
}

// --- Blind Pods & Matching ---

export async function fetchInterests(): Promise<{ interests: InterestItem[] }> {
  return apiFetch<{ interests: InterestItem[] }>('/api/interests');
}

export async function saveMyInterests(
  interests: string[]
): Promise<{ interests: InterestItem[] }> {
  return apiFetch<{ interests: InterestItem[] }>('/api/me/interests', {
    method: 'PUT',
    body: JSON.stringify({ interests }),
  });
}

export async function matchPods(
  payload: MatchPodsRequest
): Promise<MatchPodsResponse> {
  return apiFetch<MatchPodsResponse>('/api/pods/match', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function fetchPods(): Promise<{ pods: PodDetailDto[] }> {
  return apiFetch<{ pods: PodDetailDto[] }>('/api/pods');
}

export async function updatePodStatus(
  podId: string,
  customStatus: string
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/pods/${podId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ customStatus }),
  });
}

export async function updatePodMute(
  podId: string,
  muted: boolean
): Promise<{ ok: boolean; muted: boolean }> {
  return apiFetch<{ ok: boolean; muted: boolean }>(`/api/pods/${podId}/mute`, {
    method: 'PATCH',
    body: JSON.stringify({ muted }),
  });
}

export async function markAllPodsRead(): Promise<{
  ok: boolean;
  updatedConversations: number;
}> {
  return apiFetch<{ ok: boolean; updatedConversations: number }>(
    '/api/pods/read-all',
    { method: 'POST' }
  );
}

export async function leavePod(
  podId: string,
  payload: LeavePodRequest = {}
): Promise<LeavePodResponse> {
  return apiFetch<LeavePodResponse>(`/api/pods/${podId}/leave`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// --- Democratic Governance Proposals & Custom Admin Pods ---

export async function fetchPodProposals(
  podId: string
): Promise<{ proposals: PodProposalDto[] }> {
  return apiFetch<{ proposals: PodProposalDto[] }>(
    `/api/pods/${podId}/proposals`
  );
}

export async function createPodProposal(
  podId: string,
  payload: CreateProposalRequest
): Promise<{ proposal: PodProposalDto; pod: PodDetailDto }> {
  return apiFetch<{ proposal: PodProposalDto; pod: PodDetailDto }>(
    `/api/pods/${podId}/proposals`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export async function voteProposal(
  proposalId: number,
  vote: boolean
): Promise<{ proposal: PodProposalDto; pod: PodDetailDto | null }> {
  return apiFetch<{ proposal: PodProposalDto; pod: PodDetailDto | null }>(
    `/api/proposals/${proposalId}/vote`,
    {
      method: 'POST',
      body: JSON.stringify({ vote }),
    }
  );
}

export async function resolveProposal(
  proposalId: number
): Promise<{ proposal: PodProposalDto; pod: PodDetailDto | null }> {
  return apiFetch<{ proposal: PodProposalDto; pod: PodDetailDto | null }>(
    `/api/proposals/${proposalId}/resolve`,
    { method: 'POST' }
  );
}

export async function fetchPublicizedPods(
  interest = ''
): Promise<{ groups: PublicizedPodDto[] }> {
  const query = interest.trim()
    ? `?interest=${encodeURIComponent(interest.trim())}`
    : '';
  return apiFetch<{ groups: PublicizedPodDto[] }>(
    `/api/pods/publicized${query}`
  );
}

export async function joinPublicizedPod(
  podId: string
): Promise<{ pod: PodDetailDto; pods: PodDetailDto[] }> {
  return apiFetch<{ pod: PodDetailDto; pods: PodDetailDto[] }>(
    `/api/pods/${podId}/join`,
    { method: 'POST' }
  );
}

export async function createCustomPod(
  payload: CreateCustomPodRequest
): Promise<{ pod: PodDetailDto; pods: PodDetailDto[] }> {
  return apiFetch<{ pod: PodDetailDto; pods: PodDetailDto[] }>('/api/pods/custom', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updatePodSettings(
  podId: string,
  payload: UpdatePodSettingsRequest
): Promise<{ pod: PodDetailDto }> {
  return apiFetch<{ pod: PodDetailDto }>(`/api/pods/${podId}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function adminKickMember(
  podId: string,
  targetPeerId: string
): Promise<{ pod: PodDetailDto }> {
  return apiFetch<{ pod: PodDetailDto }>(`/api/pods/${podId}/admin/kick`, {
    method: 'POST',
    body: JSON.stringify({ targetPeerId }),
  });
}

export async function adminUpdateMemberRole(
  podId: string,
  targetPeerId: string,
  role: Exclude<PodMemberRole, 'OWNER'>
): Promise<{ pod: PodDetailDto }> {
  return apiFetch<{ pod: PodDetailDto }>(`/api/pods/${podId}/admin/role`, {
    method: 'POST',
    body: JSON.stringify({ targetPeerId, role }),
  });
}

// --- Pod Invites & Join-by-Code ---

export function buildWebInviteUrl(code: string): string {
  const envWeb = process.env.EXPO_PUBLIC_WEB_URL?.trim();
  if (envWeb) {
    return `${envWeb.replace(/\/+$/, '')}/invite/${encodeURIComponent(code)}`;
  }
  // ponytail: maps local Spring Boot :8090 -> Next.js :3001 when EXPO_PUBLIC_WEB_URL is unset
  const webBase = getApiBaseUrl()
    .replace('://10.0.2.2:', '://localhost:')
    .replace(/:8090$/, ':3001')
    .replace(/\/api$/, '')
    .replace(/\/+$/, '');
  return `${webBase}/invite/${encodeURIComponent(code)}`;
}

export async function createPodInvite(
  podId: string,
  payload: CreateInviteRequest = {}
): Promise<{ invite: PodInviteDto }> {
  return apiFetch<{ invite: PodInviteDto }>(`/api/pods/${podId}/invites`, {
    method: 'POST',
    body: JSON.stringify({
      maxUses: payload.maxUses ?? 0,
      expiresInHours: payload.expiresInHours ?? 168,
      regenerate: payload.regenerate ?? false,
    }),
  });
}

export async function fetchPodInvites(
  podId: string
): Promise<{ invites: PodInviteDto[] }> {
  return apiFetch<{ invites: PodInviteDto[] }>(`/api/pods/${podId}/invites`);
}

export async function revokePodInvite(
  podId: string,
  code: string
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `/api/pods/${podId}/invites/${encodeURIComponent(code)}`,
    { method: 'DELETE' }
  );
}

export async function fetchInvitePreview(
  code: string
): Promise<{ invite: PodInviteDto }> {
  return apiFetch<{ invite: PodInviteDto }>(
    `/api/invites/${encodeURIComponent(code)}`
  );
}

export async function acceptPodInvite(
  code: string
): Promise<AcceptInviteResponse> {
  return apiFetch<AcceptInviteResponse>(
    `/api/invites/${encodeURIComponent(code)}/accept`,
    { method: 'POST' }
  );
}

// --- Pod Group Chat + 1:1 Private Member Messages (DMs) ---

export async function fetchPodMessages(
  podId: string,
  beforeId = 0,
  limit = 40
): Promise<MessagesPage> {
  return apiFetch<MessagesPage>(
    `/api/pods/${podId}/messages?beforeId=${beforeId}&limit=${limit}`
  );
}

export async function postPodMessage(
  podId: string,
  payload: {
    body: string;
    quoteMessageId?: number;
    attachmentIds?: number[];
  }
): Promise<PostMessageResponse> {
  return apiFetch<PostMessageResponse>(`/api/pods/${podId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      body: payload.body,
      quoteMessageId: payload.quoteMessageId ?? 0,
      attachmentIds: payload.attachmentIds ?? [],
    }),
  });
}

export async function fetchPodDms(
  podId: string
): Promise<{ conversations: DmSummaryDto[] }> {
  return apiFetch<{ conversations: DmSummaryDto[] }>(`/api/pods/${podId}/dms`);
}

export async function fetchDmMessages(
  podId: string,
  peerId: string,
  beforeId = 0,
  limit = 40
): Promise<MessagesPage> {
  return apiFetch<MessagesPage>(
    `/api/pods/${podId}/dms/${encodeURIComponent(peerId)}/messages?beforeId=${beforeId}&limit=${limit}`
  );
}

export async function postDmMessage(
  podId: string,
  peerId: string,
  payload: {
    body: string;
    quoteMessageId?: number;
    attachmentIds?: number[];
  }
): Promise<PostMessageResponse> {
  return apiFetch<PostMessageResponse>(
    `/api/pods/${podId}/dms/${encodeURIComponent(peerId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        body: payload.body,
        quoteMessageId: payload.quoteMessageId ?? 0,
        attachmentIds: payload.attachmentIds ?? [],
      }),
    }
  );
}

export async function markPodConversationRead(
  podId: string,
  peerId: string | null,
  lastReadMessageId: number
): Promise<{ ok: boolean; lastReadMessageId: number }> {
  return apiFetch<{ ok: boolean; lastReadMessageId: number }>(
    `/api/pods/${podId}/read`,
    {
      method: 'POST',
      body: JSON.stringify({ peerId, lastReadMessageId }),
    }
  );
}

export async function editMessage(
  messageId: number,
  body: string
): Promise<{ message: RichMessageDto }> {
  return apiFetch<{ message: RichMessageDto }>(`/api/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
}

export async function deleteMessage(
  messageId: number
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/messages/${messageId}`, {
    method: 'DELETE',
  });
}

export async function toggleReaction(
  messageId: number,
  emoji: string
): Promise<{ message: RichMessageDto }> {
  return apiFetch<{ message: RichMessageDto }>(
    `/api/messages/${messageId}/reactions`,
    {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    }
  );
}

export async function togglePin(
  messageId: number
): Promise<{ message: RichMessageDto }> {
  return apiFetch<{ message: RichMessageDto }>(`/api/messages/${messageId}/pin`, {
    method: 'POST',
  });
}

export async function toggleBookmark(
  messageId: number
): Promise<{ bookmarked: boolean; message: RichMessageDto }> {
  return apiFetch<{ bookmarked: boolean; message: RichMessageDto }>(
    `/api/messages/${messageId}/bookmark`,
    { method: 'POST' }
  );
}

export async function votePoll(
  pollId: number,
  optionIndex: number
): Promise<{ message: RichMessageDto }> {
  return apiFetch<{ message: RichMessageDto }>(`/api/polls/${pollId}/vote`, {
    method: 'POST',
    body: JSON.stringify({ optionIndex }),
  });
}

export async function closePoll(
  pollId: number
): Promise<{ message: RichMessageDto }> {
  return apiFetch<{ message: RichMessageDto }>(`/api/polls/${pollId}/close`, {
    method: 'POST',
  });
}

export async function fetchPins(
  podId: string
): Promise<{ messages: RichMessageDto[] }> {
  return apiFetch<{ messages: RichMessageDto[] }>(`/api/pods/${podId}/pins`);
}

export async function fetchBookmarks(): Promise<{ messages: RichMessageDto[] }> {
  return apiFetch<{ messages: RichMessageDto[] }>('/api/bookmarks');
}

export async function searchPodMessages(
  podId: string,
  query: string
): Promise<{ messages: RichMessageDto[] }> {
  return apiFetch<{ messages: RichMessageDto[] }>(
    `/api/pods/${podId}/search?q=${encodeURIComponent(query)}`
  );
}

export async function uploadVoiceNoteAttachment(
  podId: string,
  fileUri: string,
  durationMs: number
): Promise<AttachmentItem> {
  const formData = new FormData();
  if (Platform.OS === 'web') {
    const blobRes = await fetch(fileUri);
    const blob = await blobRes.blob();
    const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
    formData.append('file', blob, `voice-note-${Date.now()}.${ext}`);
  } else {
    const ext = fileUri.split('.').pop() || 'm4a';
    const mimeType = ext === 'webm' ? 'audio/webm' : 'audio/mp4';
    // React Native FormData file descriptor
    formData.append('file', {
      uri: fileUri,
      name: `voice-note-${Date.now()}.${ext}`,
      type: mimeType,
    } as unknown as Blob);
  }
  formData.append('kind', 'voice_note');
  formData.append('durationMs', String(Math.max(0, Math.round(durationMs))));

  return apiFetch<AttachmentItem>(`/api/pods/${podId}/attachments`, {
    method: 'POST',
    body: formData,
  });
}

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8090';

export const WS_BASE =
  process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8090';

const LOCAL_TOKEN_KEY = 'canopy_jwt';
const TAB_TOKEN_KEY = 'canopy_tab_jwt';
const TAB_MODE_KEY = 'canopy_tab_isolated';

export function enableTabIsolatedMode(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(TAB_MODE_KEY, '1');
}

export function isTabIsolatedMode(): boolean {
  if (typeof window === 'undefined') return false;
  return window.sessionStorage.getItem(TAB_MODE_KEY) === '1';
}

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  if (isTabIsolatedMode()) {
    return window.sessionStorage.getItem(TAB_TOKEN_KEY);
  }
  return (
    window.sessionStorage.getItem(TAB_TOKEN_KEY) ||
    window.localStorage.getItem(LOCAL_TOKEN_KEY)
  );
}

export function setAuthToken(token: string, tabOnly = false): void {
  if (typeof window === 'undefined') return;
  if (tabOnly || isTabIsolatedMode()) {
    window.sessionStorage.setItem(TAB_MODE_KEY, '1');
    window.sessionStorage.setItem(TAB_TOKEN_KEY, token);
  } else {
    window.localStorage.setItem(LOCAL_TOKEN_KEY, token);
  }
}

export function clearAuthToken(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(TAB_TOKEN_KEY);
  if (!isTabIsolatedMode()) {
    window.localStorage.removeItem(LOCAL_TOKEN_KEY);
  }
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
  const token = getAuthToken();
  const headers = new Headers(init.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (
    init.body &&
    typeof init.body === 'string' &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json');
  }

  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const errJson = await res.json();
      msg = errJson.error || errJson.message || msg;
    } catch {
      // ignore json parse failure
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
    : `${API_BASE}${pathOrUrl}`;
  const token = getAuthToken();
  if (!token) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

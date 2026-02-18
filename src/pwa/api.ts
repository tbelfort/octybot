import { WORKER_URL, TOKEN, setToken } from "./state";

// Forward declaration — set by auth-setup module
let _kickToSetup: () => void = () => {};
export function registerKickToSetup(fn: () => void) { _kickToSetup = fn; }

function handleAuthHeaders(resp: Response) {
  const refreshToken = resp.headers.get("X-Refresh-Token");
  if (refreshToken) {
    setToken(refreshToken);
  }
}

export async function api(path: string, options: RequestInit = {}): Promise<any> {
  const resp = await fetch(`${WORKER_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  handleAuthHeaders(resp);

  if (!resp.ok && resp.status !== 204) {
    if (resp.status === 401 || resp.status === 403) {
      _kickToSetup();
      return null;
    }
    throw new Error(`API ${resp.status}: ${await resp.text()}`);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

export async function rawFetch(path: string, options: RequestInit = {}): Promise<Response | null> {
  const resp = await fetch(`${WORKER_URL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(options.headers || {}) },
  });
  handleAuthHeaders(resp);
  if (resp.status === 401 || resp.status === 403) {
    _kickToSetup();
    return null;
  }
  return resp;
}

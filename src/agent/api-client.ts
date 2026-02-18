/**
 * API client — token state, auth headers, fetch wrapper with token refresh.
 * Depends on: config.ts
 */

import { loadConfig, saveConfig, WORKER_URL } from "./config";

// --- Mutable token state ---

let currentToken = "";

export function getToken(): string {
  return currentToken;
}

export function setToken(token: string) {
  currentToken = token;
}

// --- Auth + fetch ---

export function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${currentToken}`,
    "Content-Type": "application/json",
  };
}

export async function api(path: string, options?: RequestInit) {
  const resp = await fetch(`${WORKER_URL}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...options?.headers },
  });

  // Handle token refresh
  const refreshToken = resp.headers.get("X-Refresh-Token");
  if (refreshToken) {
    currentToken = refreshToken;
    const config = loadConfig();
    if (config) {
      saveConfig({ ...config, token: refreshToken });
    }
    console.log("Token refreshed");
  }

  return resp;
}

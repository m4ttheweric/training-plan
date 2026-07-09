import { getTokens, saveTokens } from "../db";

const STRAVA_API = "https://www.strava.com/api/v3";
const TOKEN_URL = "https://www.strava.com/oauth/token";

async function refreshIfNeeded(): Promise<string> {
  let tokens = getTokens();

  if (!tokens) {
    const accessToken = process.env.STRAVA_ACCESS_TOKEN;
    const refreshToken = process.env.STRAVA_REFRESH_TOKEN;
    if (!accessToken || !refreshToken) throw new Error("No Strava tokens configured");
    saveTokens(accessToken, refreshToken, 0);
    tokens = getTokens()!;
  }

  const now = Math.floor(Date.now() / 1000);
  if (tokens.expires_at > now + 60) return tokens.access_token;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };

  saveTokens(data.access_token, data.refresh_token, data.expires_at);
  console.log("Strava token refreshed, expires at", new Date(data.expires_at * 1000).toISOString());
  return data.access_token;
}

export async function stravaGet<T = unknown>(path: string, params?: Record<string, string | number>): Promise<T> {
  const token = await refreshIfNeeded();
  const url = new URL(STRAVA_API + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429) {
    const resetAt = res.headers.get("X-RateLimit-Reset");
    throw new Error(`Strava rate limited. Resets at ${resetAt ? new Date(Number(resetAt) * 1000).toISOString() : "unknown"}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export async function stravaPut<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  const token = await refreshIfNeeded();
  const url = STRAVA_API + path;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const resetAt = res.headers.get("X-RateLimit-Reset");
    throw new Error(`Strava rate limited. Resets at ${resetAt ? new Date(Number(resetAt) * 1000).toISOString() : "unknown"}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Strava API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export function getAuthUrl() {
  const base = process.env.BASE_URL || "https://training.localhost";
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID!,
    redirect_uri: `${base}/auth/strava/callback`,
    response_type: "code",
    scope: "read,activity:read_all,activity:write",
    approval_prompt: "auto",
  });
  return `https://www.strava.com/oauth/authorize?${params}`;
}

export async function exchangeCode(code: string) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) throw new Error(`Code exchange failed: ${await res.text()}`);

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    athlete: { id: number; firstname: string; lastname: string };
  };

  saveTokens(data.access_token, data.refresh_token, data.expires_at, data.athlete.id, JSON.stringify(data.athlete));
  return data;
}

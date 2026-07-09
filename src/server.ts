import { join, extname } from "path";
import { getAuthUrl, exchangeCode, stravaPut } from "./strava/client";
import { syncActivities } from "./strava/sync";
import { getActivities, getWeeklyStats, getActivityCount, getLastSyncedDate, getTokens, updateActivityName } from "./db";
import { getPlanStatus, getAvailablePlans } from "./plan";

const PORT = parseInt(process.env.PORT || "8081");
const PUBLIC_DIR = join(import.meta.dir, "../public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function serveStatic(pathname: string): Promise<Response> {
  if (pathname === "/") pathname = "/index.html";

  const filePath = join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) return new Response("Forbidden", { status: 403 });

  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("Not Found", { status: 404 });

  const ext = extname(filePath).toLowerCase();
  return new Response(file, {
    headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
  });
}

let syncing = false;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- Auth routes ---
    if (path === "/auth/strava") {
      return Response.redirect(getAuthUrl(), 302);
    }

    if (path === "/auth/strava/callback") {
      const code = url.searchParams.get("code");
      if (!code) return json({ error: "Missing code parameter" }, 400);
      try {
        const data = await exchangeCode(code);
        return Response.redirect("/activities.html?auth=success&name=" + encodeURIComponent(data.athlete.firstname), 302);
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // --- API routes ---
    if (path === "/api/status") {
      const tokens = getTokens();
      return json({
        authenticated: !!tokens,
        athleteId: tokens?.athlete_id ?? null,
        athlete: tokens?.athlete_json ? JSON.parse(tokens.athlete_json) : null,
        activityCount: getActivityCount(),
        lastSynced: getLastSyncedDate(),
        syncing,
      });
    }

    if (path === "/api/sync" && req.method === "POST") {
      if (syncing) return json({ error: "Sync already in progress" }, 409);
      syncing = true;
      try {
        const body = req.headers.get("content-type")?.includes("json")
          ? await req.json() as { full?: boolean }
          : {};
        const result = await syncActivities({ full: (body as { full?: boolean }).full });
        return json(result);
      } catch (e) {
        return json({ error: String(e) }, 500);
      } finally {
        syncing = false;
      }
    }

    if (path === "/api/activities") {
      const type = url.searchParams.get("type") ?? undefined;
      const after = url.searchParams.get("after") ?? undefined;
      const before = url.searchParams.get("before") ?? undefined;
      const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
      const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;
      return json(getActivities({ type, after, before, limit, offset }));
    }

    const activityMatch = path.match(/^\/api\/activities\/(\d+)\/name$/);
    if (activityMatch && req.method === "PUT") {
      const stravaId = Number(activityMatch[1]);
      try {
        const body = await req.json() as { name: string };
        if (!body.name?.trim()) return json({ error: "Name is required" }, 400);
        const name = body.name.trim();
        await stravaPut(`/activities/${stravaId}`, { name });
        updateActivityName(stravaId, name);
        return json({ ok: true, name });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (path === "/api/plans") {
      return json(getAvailablePlans());
    }

    if (path === "/api/plan/status") {
      const planId = url.searchParams.get("plan") ?? undefined;
      const asOf = url.searchParams.get("as_of") ?? undefined;
      return json(getPlanStatus(planId, asOf));
    }

    if (path === "/api/stats/weekly") {
      const after = url.searchParams.get("after") ?? undefined;
      const type = url.searchParams.get("type") ?? undefined;
      return json(getWeeklyStats({ after, type }));
    }

    // --- Static files ---
    return serveStatic(path);
  },
});

console.log(`Training app running at http://localhost:${PORT}`);

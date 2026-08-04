import { join, extname } from "path";
import { getAuthUrl, exchangeCode } from "./strava/client";
import { syncActivities } from "./strava/sync";
import { getActivities, getWeeklyStats, getActivityCount, getLastSyncedDate, getTokens, getSplitsForActivity, getFeedbackForActivity, upsertFeedback } from "./db";
import { getPlanStatus, getAvailablePlans } from "./plan";
import { getToday } from "./today";
import { getJournal } from "./journal";

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

// The timestamp a sync last finished (success or failure), independent of
// getLastSyncedDate()'s MAX(start_date_local) -- that reads the newest
// ACTIVITY's date, not when the app last talked to Strava, so a plan built
// around "last synced" needs this instead. In-memory only; it resets on
// restart, which is fine for a personal single-instance app.
let lastSyncCompletedAt: string | null = null;

// Every page load asks for an auto sync, but navigating between Today,
// Journal and Plan within a few seconds must not fire three real Strava
// pulls: Strava allows ~100 requests/15min and 1000/day, and one sync can
// burn several of those (activity pages + per-activity weather/split
// backfill). 5 minutes comfortably covers a tab-hopping session while still
// keeping data fresh across a normal day of checking in on the plan.
const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
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
        return Response.redirect("/?auth=success&name=" + encodeURIComponent(data.athlete.firstname), 302);
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
        // Kept for backwards compatibility -- this is the newest activity's
        // date, not when a sync last ran. lastSyncCompletedAt below is the
        // genuine sync timestamp.
        lastSynced: getLastSyncedDate(),
        lastSyncCompletedAt,
        syncing,
      });
    }

    if (path === "/api/sync" && req.method === "POST") {
      const body = req.headers.get("content-type")?.includes("json")
        ? await req.json() as { full?: boolean; auto?: boolean }
        : {};
      const isAuto = (body as { auto?: boolean }).auto === true;

      // A manual sync (no auto flag) always runs. An auto sync is skipped
      // outright if one finished within the throttle window, before even
      // checking whether a sync is currently in flight.
      if (isAuto && lastSyncCompletedAt !== null &&
          Date.now() - Date.parse(lastSyncCompletedAt) < AUTO_SYNC_MIN_INTERVAL_MS) {
        return json({ skipped: true });
      }

      if (syncing) return json({ error: "Sync already in progress" }, 409);
      syncing = true;
      syncActivities({ full: (body as { full?: boolean }).full })
        .catch((e) => console.error("Sync failed:", e))
        .finally(() => { syncing = false; lastSyncCompletedAt = new Date().toISOString(); });
      return json({ started: true });
    }

    if (path === "/api/activities") {
      const type = url.searchParams.get("type") ?? undefined;
      const after = url.searchParams.get("after") ?? undefined;
      const before = url.searchParams.get("before") ?? undefined;
      const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
      const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined;
      return json(getActivities({ type, after, before, limit, offset }));
    }

    const splitsMatch = path.match(/^\/api\/activities\/(\d+)\/splits$/);
    if (splitsMatch && req.method === "GET") {
      const stravaId = Number(splitsMatch[1]);
      const splits = getSplitsForActivity(stravaId);
      if (!splits.length) return json({ error: "No splits found" }, 404);
      return json({ splits });
    }

    const feedbackMatch = path.match(/^\/api\/activities\/(\d+)\/feedback$/);
    if (feedbackMatch) {
      const stravaId = Number(feedbackMatch[1]);
      if (req.method === "GET") {
        const feedback = getFeedbackForActivity(stravaId);
        if (!feedback) return json({ error: "No feedback found" }, 404);
        return json(feedback);
      }
      if (req.method === "POST") {
        try {
          const body = await req.json() as {
            plan_date: string; plan_id: string;
            prescribed_type: string; prescribed_miles: number | null;
            analysis_json: string; narrative: string;
          };
          upsertFeedback(stravaId, body);
          return json({ ok: true });
        } catch (e) {
          return json({ error: String(e) }, 500);
        }
      }
    }

    if (path === "/api/today") {
      const asOf = url.searchParams.get("as_of") ?? undefined;
      return json(getToday(asOf));
    }

    if (path === "/api/journal") {
      const asOf = url.searchParams.get("as_of") ?? undefined;
      return json(getJournal(asOf));
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

import { join, extname } from "path";
import { getAuthUrl, exchangeCode } from "./strava/client";
import { syncActivities } from "./strava/sync";
import { getActivities, getWeeklyStats, getActivityCount, getLastSyncedDate, getTokens, getSplitsForActivity, getFeedbackForActivity, upsertFeedback, createFeedbackRequest, finishFeedbackRequest, getLatestFeedbackRequest, getActivityByStravaId } from "./db";
import { getPlanStatus, getAvailablePlans } from "./plan";
import { getToday } from "./today";
import { getJournal } from "./journal";
import { ANALYZE_TIMEOUT_MS, buildAnalyzeCommand, normalizeNote, resolveAccount } from "./analyze";

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

/* One analysis at a time process-wide, mirroring `syncing` above. A spawn
   holds a Claude session open for up to ANALYZE_TIMEOUT_MS, so overlapping
   runs would contend for the same account's rate limit for no benefit. */
let analyzing = false;

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

/* Spawns the pinned headless Claude session and returns immediately. The
   caller polls GET /api/activities/:id/analyze for the outcome.

   Success is defined as exit code 0, NOT the presence of a feedback row. The
   two are tracked separately so a session that exits clean without writing
   feedback stays visible as a request whose feedback never appeared. */
function startAnalysis(
  stravaId: number, date: string, note: string | null, account: string,
): number {
  const requestId = createFeedbackRequest(stravaId, note);
  analyzing = true;

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(buildAnalyzeCommand({ account, date, note }), {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    // Most likely ENOENT: cswap or claude missing from the service PATH.
    finishFeedbackRequest(requestId, "failed", String(e), null);
    analyzing = false;
    return requestId;
  }

  const killTimer = setTimeout(() => proc.kill(), ANALYZE_TIMEOUT_MS);

  (async () => {
    try {
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        finishFeedbackRequest(requestId, "done", null, 0);
      } else {
        const tail = stderr.slice(-2000).trim();
        finishFeedbackRequest(
          requestId, "failed", tail || `Analysis exited with code ${exitCode}`, exitCode,
        );
      }
    } catch (e) {
      finishFeedbackRequest(requestId, "failed", String(e), null);
    } finally {
      clearTimeout(killTimer);
      analyzing = false;
    }
  })();

  return requestId;
}

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

    const analyzeMatch = path.match(/^\/api\/activities\/(\d+)\/analyze$/);
    if (analyzeMatch) {
      const stravaId = Number(analyzeMatch[1]);

      if (req.method === "GET") {
        const request = getLatestFeedbackRequest(stravaId);
        if (!request) return json({ error: "No analysis requested" }, 404);
        return json(request);
      }

      if (req.method === "POST") {
        const body = req.headers.get("content-type")?.includes("json")
          ? await req.json() as { note?: string; force?: boolean }
          : {};

        const activity = getActivityByStravaId(stravaId);
        if (!activity || activity.type !== "Run") return json({ error: "Not a run" }, 404);

        // Re-analysis overwrites the existing feedback row, so it needs an
        // explicit force. Enforced here, not only in the dialog, so a stray
        // request cannot discard an analysis.
        if (getFeedbackForActivity(stravaId) && body.force !== true)
          return json({ error: "Feedback already exists", requires_confirmation: true }, 409);

        if (analyzing) return json({ error: "Analysis already in progress" }, 409);

        let account: string;
        try {
          account = resolveAccount(process.env);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }

        const date = String(activity.start_date_local ?? "").slice(0, 10);
        if (!date) return json({ error: "Activity has no date" }, 500);

        const requestId = startAnalysis(stravaId, date, normalizeNote(body.note), account);
        return json({ started: true, request_id: requestId }, 202);
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

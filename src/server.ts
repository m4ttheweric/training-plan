import { join, extname } from "path";
import { getAuthUrl, exchangeCode, isStravaConfigured } from "./strava/client";
import { syncActivities } from "./strava/sync";
import { getActivities, getWeeklyStats, getActivityCount, getLastSyncedDate, getTokens, getSplitsForActivity, getFeedbackForActivity, upsertFeedback, createFeedbackRequest, finishFeedbackRequest, getLatestFeedbackRequest, getActivityByStravaId, upsertDailyMetrics, getDailyMetricsWide, getDailyMetricsSummary } from "./db";
import { parseHealthExport } from "./health";
import { getPlanStatus, getAvailablePlans } from "./plan";
import { getRecovery } from "./recovery";
import { getToday } from "./today";
import { getJournal } from "./journal";
import { ANALYZE_TIMEOUT_MS, buildAnalyzeCommand, buildSpawnEnv, decideAnalyzeRequest, normalizeNote, resolveAccount, getAnalysisAvailability, parseAnalysisOutput } from "./analyze";

import { getServerConfig } from "./config";
const { port: PORT, hostname: HOST } = getServerConfig(process.env);
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
let lastSyncError: string | null = null;

// Every page load asks for an auto sync, but navigating between Today,
// Journal and Plan within a few seconds must not fire three real Strava
// pulls: Strava allows ~100 requests/15min and 1000/day, and one sync can
// burn several of those (activity pages + per-activity weather/split
// backfill). 5 minutes comfortably covers a tab-hopping session while still
// keeping data fresh across a normal day of checking in on the plan.
const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;

/* A killed claude can leave grandchildren (a Bash tool shell, an in flight
   curl) holding the stderr write end open, so a read that waits for EOF may
   never settle. Stream reads are therefore best effort and everything below
   is bounded by a timer that cannot itself hang. */
const STREAM_GRACE_MS = 5 * 1000;
const SIGKILL_GRACE_MS = 10 * 1000;
const RELEASE_GRACE_MS = 20 * 1000;
const OUTPUT_TAIL_CHARS = 64000;

/* Drains a stream to completion but keeps only the last OUTPUT_TAIL_CHARS, so
   a chatty child cannot balloon server memory. The tail is the useful end for
   diagnosis. */
async function readTail(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tail = (tail + decoder.decode(value, { stream: true })).slice(-OUTPUT_TAIL_CHARS);
    }
  } catch {
    // The stream closed under us. Whatever we already have is what we report.
  } finally {
    try { reader.cancel(); } catch {}
  }
  return tail;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/* Spawns the pinned headless Claude session and returns immediately. The
   caller polls GET /api/activities/:id/analyze for the outcome.

   Success requires valid output and a persisted feedback row. A CLI failure,
   invalid response, or database write failure remains visible to the user. */
function startAnalysis(
  stravaId: number, date: string, note: string | null, account?: string,
): number {
  const status = getPlanStatus(undefined, date);
  const slot = status.weeks.flatMap(week => week.days).find(day => day.actual?.strava_id === stravaId);
  const metrics = (activity: Record<string, unknown>) => Object.fromEntries([
    "strava_id", "name", "type", "distance", "moving_time", "start_date_local", "average_speed",
    "average_heartrate", "max_heartrate", "average_cadence", "total_elevation_gain",
    "weather_temp", "weather_feels", "weather_humidity", "weather_wind",
  ].map(key => [key, activity[key] ?? null]));
  const context = {
    activity: metrics(getActivityByStravaId(stravaId)!),
    splits: getSplitsForActivity(stravaId),
    prescribed: slot?.plan ?? null,
    plan: { id: status.plan.id, race: status.plan.race, phases: status.plan.phases, glossary: status.plan.glossary, rules: status.plan.rules },
    recentRuns: getActivities({ type: "Run", before: date + "T23:59:59", limit: 20 }).map(activity => metrics(activity as Record<string, unknown>)),
    dailyHealth: getDailyMetricsWide({ after: date, before: date }),
  };
  const requestId = createFeedbackRequest(stravaId, note);
  analyzing = true;

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(buildAnalyzeCommand({ account, date, note, context }), {
      cwd: join(import.meta.dir, ".."),
      env: buildSpawnEnv(process.env),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    // Most likely ENOENT: cswap or claude missing from the service PATH.
    try {
      finishFeedbackRequest(requestId, "failed", String(e), null);
    } catch (dbErr) {
      console.error("Failed to record spawn failure for request", requestId, dbErr);
    } finally {
      analyzing = false;
    }
    return requestId;
  }

  /* Start draining immediately. Bun buffers a pipe eagerly, so waiting until
     after proc.exited to begin reading means a chatty child's entire output is
     already resident: measured 1038 MB, versus 64 MB when drained from the
     start. These are best effort and are raced against a grace timeout below. */
  const outTail = readTail(proc.stdout);
  const errTail = readTail(proc.stderr);

  let settled = false;
  let timedOut = false;
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

  /* Every exit path funnels through here exactly once, and releasing the
     mutex is the last thing it does. The database write is guarded because
     this runs from bare timer callbacks, where a throw would be uncaught and
     would take the whole server down. */
  const settle = (status: "done" | "failed", error: string | null, exitCode: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    clearTimeout(releaseTimer);
    clearTimeout(sigkillTimer);
    try {
      finishFeedbackRequest(requestId, status, error, exitCode);
    } catch (e) {
      console.error("Failed to record analysis outcome for request", requestId, e);
    } finally {
      analyzing = false;
    }
  };

  /* SIGTERM at the deadline, then SIGKILL if it is ignored, so the timeout is
     a real cap rather than a polite request. */
  const killTimer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
    sigkillTimer = setTimeout(() => { try { proc.kill(9); } catch {} }, SIGKILL_GRACE_MS);
  }, ANALYZE_TIMEOUT_MS);

  /* The backstop. If the child is gone but a grandchild still holds a pipe
     open, the reads below may never settle. This releases the mutex anyway so
     one wedged run cannot disable the feature until the next restart. */
  const releaseTimer = setTimeout(() => {
    settle("failed", "Analysis timed out and did not exit cleanly.", null);
  }, ANALYZE_TIMEOUT_MS + SIGKILL_GRACE_MS + RELEASE_GRACE_MS);

  (async () => {
    try {
      // proc.exited tracks the direct child, so it settles even when a
      // grandchild is still holding the pipes open.
      const exitCode = await proc.exited;
      const [out, err] = await Promise.all([
        withTimeout(outTail, STREAM_GRACE_MS, ""),
        withTimeout(errTail, STREAM_GRACE_MS, ""),
      ]);

      if (exitCode === 0 && !timedOut) {
        const feedback = parseAnalysisOutput(out);
        upsertFeedback(stravaId, {
          plan_date: slot?.date ?? date, plan_id: status.plan.id,
          prescribed_type: slot?.plan.type ?? "unplanned", prescribed_miles: slot?.plan.miles ?? null,
          analysis_json: JSON.stringify(feedback.analysis), narrative: feedback.narrative,
        });
        settle("done", null, 0);
        return;
      }

      // claude -p reports its failures on stdout, so stderr alone is usually
      // empty. Prefer stderr, fall back to stdout, and say so when we killed it.
      const detail = (err.trim() || out.trim() || "").slice(-OUTPUT_TAIL_CHARS);
      const prefix = timedOut
        ? `Analysis timed out after ${Math.round(ANALYZE_TIMEOUT_MS / 60000)} minutes. `
        : "";
      settle("failed", (prefix + detail).trim() || `Analysis exited with code ${exitCode}`, exitCode);
    } catch (e) {
      settle("failed", String(e), null);
    }
  })();

  return requestId;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {

    // --- Auth routes ---
    if (path === "/auth/strava") {
      if (!isStravaConfigured()) return json({ error: "Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET to connect Strava" }, 503);
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
        stravaConfigured: isStravaConfigured(),
        analysis: getAnalysisAvailability(process.env),
        syncError: lastSyncError,
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

      if (!isStravaConfigured()) {
        return isAuto ? json({ skipped: true }) : json({ error: "Strava is not configured" }, 503);
      }
      if (!getTokens() && !(process.env.STRAVA_ACCESS_TOKEN && process.env.STRAVA_REFRESH_TOKEN)) {
        return isAuto ? json({ skipped: true }) : json({ error: "Connect Strava before syncing" }, 401);
      }
      if (syncing) return json({ error: "Sync already in progress" }, 409);
      lastSyncError = null;
      syncing = true;
      syncActivities({ full: (body as { full?: boolean }).full })
        .catch((e) => { lastSyncError = String(e); console.error("Sync failed:", e); })
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
        const decision = decideAnalyzeRequest({
          activityType: activity ? String(activity.type ?? "") : null,
          hasFeedback: !!getFeedbackForActivity(stravaId),
          force: body.force === true,
          analyzing,
        });
        if (!decision.ok) return json(decision.body, decision.status);

        const availability = getAnalysisAvailability(process.env);
        if (!availability.available) return json({ error: availability.message }, 503);
        let account: string | undefined;
        try {
          account = resolveAccount(process.env);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }

        /* decideAnalyzeRequest already 404s a null activity, but it takes the
           type rather than the row, so the compiler cannot see the two are
           linked. Restating it here is redundant at runtime and cheap. */
        if (!activity) return json({ error: "Not a run" }, 404);

        const date = String(activity.start_date_local ?? "").slice(0, 10);
        if (!date) return json({ error: "Activity has no date" }, 500);

        try {
          const requestId = startAnalysis(stravaId, date, normalizeNote(body.note), account);
          return json({ started: true, request_id: requestId }, 202);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500);
        }
      }
    }

    if (path === "/api/health") {
      if (req.method === "GET") {
        if (url.searchParams.get("summary") === "1") return json(getDailyMetricsSummary());
        const after = url.searchParams.get("after") ?? undefined;
        const before = url.searchParams.get("before") ?? undefined;
        const metrics = url.searchParams.get("metrics")?.split(",").filter(Boolean);
        return json(getDailyMetricsWide({ after, before, metrics }));
      }

      if (req.method === "POST") {
        try {
          const rows = parseHealthExport(await req.json());
          if (!rows.length) {
            return json({ error: "No recognisable Health Auto Export metrics in body" }, 400);
          }
          const dates = rows.map((r) => r.date);
          return json({
            imported: upsertDailyMetrics(rows),
            days: new Set(dates).size,
            metrics: new Set(rows.map((r) => r.metric)).size,
            first_date: dates.reduce((a, b) => (a < b ? a : b)),
            last_date: dates.reduce((a, b) => (a > b ? a : b)),
          });
        } catch (e) {
          return json({ error: String(e) }, 400);
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

    if (path === "/api/stats/recovery") {
      const planId = url.searchParams.get("plan") ?? undefined;
      const asOf = url.searchParams.get("as_of") ?? undefined;
      return json(getRecovery(planId, asOf));
    }

    // --- Static files ---
    return await serveStatic(path);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  },
});

console.log(`Training app running at http://localhost:${PORT}`);

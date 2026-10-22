import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TEST_APP_ROOT lets this contract suite demonstrate failures against an old snapshot.
const root = process.env.TEST_APP_ROOT || join(import.meta.dir, "..");
let dir: string;
let base: string;
let proc: Bun.Subprocess;
let postPath: string;
let urlPath: string;
let argsPath: string;
// The skill sends a stale plan_id on purpose: the server owns the plan fields.
const goodFeedback = JSON.stringify({ plan_id: "stale-plan", analysis_json: JSON.stringify({ key_findings: ["Even effort"] }), narrative: "A steady run." });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "training-server-test-"));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("test") });
  const port = probe.port;
  probe.stop(true);
  base = `http://127.0.0.1:${port}`;
  const bin = join(dir, ".local/bin");
  mkdirSync(bin, { recursive: true });
  postPath = join(dir, "post.json");
  urlPath = join(dir, "url.txt");
  argsPath = join(dir, "args.txt");
  writeFileSync(postPath, goodFeedback);
  writeFileSync(urlPath, `${base}/api/activities/123/feedback`);
  // Stands in for the skill: records its arguments and saves feedback the way the skill does.
  writeFileSync(join(bin, "claude"), `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_CLAUDE_ARGS_FILE"
if [ -s "$FAKE_CLAUDE_POST_FILE" ]; then
  curl -s -o /dev/null -X POST -H 'Content-Type: application/json' --data @"$FAKE_CLAUDE_POST_FILE" "$(cat "$FAKE_CLAUDE_URL_FILE")"
fi
`);
  chmodSync(join(bin, "claude"), 0o755);
  const env = { ...process.env, HOME: dir, DATA_DIR: join(dir, "new/data"), PORT: String(port), HOST: "127.0.0.1", BASE_URL: "", PLAN_ID: "10k-oct-2026", FEEDBACK_ENABLED: "true", FEEDBACK_CLAUDE_ACCOUNT: "", STRAVA_CLIENT_ID: "", STRAVA_CLIENT_SECRET: "", STRAVA_ACCESS_TOKEN: "", STRAVA_REFRESH_TOKEN: "", FAKE_CLAUDE_POST_FILE: postPath, FAKE_CLAUDE_URL_FILE: urlPath, FAKE_CLAUDE_ARGS_FILE: argsPath };
  const seed = Bun.spawnSync([process.execPath, "-e", `import { upsertActivity, insertLaps } from './src/db'; for (const [id,day] of [[123,'06'],[124,'08']]) upsertActivity({id,name:'Test run',type:'Run',sport_type:'Run',distance:4828,moving_time:1800,start_date:'2026-07-'+day+'T12:00:00Z',start_date_local:'2026-07-'+day+'T07:00:00',average_speed:2.682}); insertLaps(123, [{lap_index:1,distance:104,elapsed_time:20,moving_time:20,average_speed:5.2,max_speed:6.42,average_heartrate:133.6,max_heartrate:140,total_elevation_gain:0}]);`], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  if (seed.exitCode !== 0) throw new Error(new TextDecoder().decode(seed.stderr));
  proc = Bun.spawn([process.execPath, "src/server.ts"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(base + "/api/status")).ok) return; } catch {}
    await Bun.sleep(30);
  }
  throw new Error("Test server failed to start");
}, 10000);

afterAll(async () => {
  if (proc) { proc.kill(); await proc.exited; }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: unknown) {
  return fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function outcome(id = 123) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const request = await fetch(base + `/api/activities/${id}/analyze`).then(r => r.json()) as any;
    if (request.status !== "running") return request;
    await Bun.sleep(30);
  }
  throw new Error("Analysis did not finish");
}

test("fresh setup serves pages and reports optional integrations", async () => {
  const status = await fetch(base + "/api/status").then(r => r.json()) as any;
  expect(status.stravaConfigured).toBe(false);
  expect(status.analysis.available).toBe(true);
  for (const path of ["/", "/journal.html", "/plan.html", "/api/today", "/api/journal", "/api/plan/status"]) {
    expect((await fetch(base + path)).status).toBe(200);
  }
});

test("unconfigured Strava skips automatic sync and explains manual setup", async () => {
  expect(await post("/api/sync", { auto: true }).then(r => r.json())).toEqual({ skipped: true });
  expect((await post("/api/sync", {})).status).toBe(503);
  expect((await fetch(base + "/auth/strava", { redirect: "manual" })).status).toBe(503);
});

test("invalid plan IDs return JSON errors without reading outside plans", async () => {
  const response = await fetch(base + "/api/plan/status?plan=..%2Fpackage");
  expect(response.status).toBe(400);
  expect((await response.json() as any).error).toMatch(/plan ID/);
});

test("laps are served per activity", async () => {
  const laps = await fetch(base + "/api/activities/123/laps").then(r => r.json()) as any;
  expect(laps.laps).toHaveLength(1);
  expect(laps.laps[0].max_speed).toBe(6.42);
  expect((await fetch(base + "/api/activities/124/laps")).status).toBe(404);
});

test("feedback the skill saves is stored against the prescribed run", async () => {
  expect((await post("/api/activities/123/analyze", { note: "Felt easy" })).status).toBe(202);
  expect((await outcome()).status).toBe("done");
  const args = readFileSync(argsPath, "utf8");
  expect(args).toContain("/run-feedback 2026-07-06");
  expect(args).toContain("Activity: 123");
  expect(args).toContain("Felt easy");
  const feedback = await fetch(base + "/api/activities/123/feedback").then(r => r.json()) as any;
  expect(feedback.narrative).toBe("A steady run.");
  expect(feedback.plan_date).toBe("2026-07-06");
  expect(feedback.plan_id).toBe("10k-oct-2026");
  expect(feedback.prescribed_miles).toBe(3);
});

test("a run that exits without saving feedback fails and keeps the old feedback", async () => {
  const confirmation = await post("/api/activities/123/analyze", {});
  expect(confirmation.status).toBe(409);
  expect((await confirmation.json() as any).requires_confirmation).toBe(true);
  writeFileSync(postPath, "");
  expect((await post("/api/activities/123/analyze", { force: true })).status).toBe(202);
  const request = await outcome();
  expect(request.status).toBe("failed");
  expect(request.error).toMatch(/without saving feedback/);
  expect((await fetch(base + "/api/activities/123/feedback").then(r => r.json()) as any).narrative).toBe("A steady run.");
});

test("invalid feedback is rejected and keeps the old feedback", async () => {
  const response = await post("/api/activities/123/feedback", { analysis_json: "not JSON", narrative: "Replaced" });
  expect(response.status).toBe(400);
  expect((await post("/api/activities/123/feedback", { analysis_json: "{}", narrative: " " })).status).toBe(400);
  expect((await fetch(base + "/api/activities/123/feedback").then(r => r.json()) as any).narrative).toBe("A steady run.");
});

test("analysis retains the dashboard prescription for a run completed early", async () => {
  writeFileSync(postPath, goodFeedback);
  writeFileSync(urlPath, `${base}/api/activities/124/feedback`);
  expect((await post("/api/activities/124/analyze", {})).status).toBe(202);
  expect((await outcome(124)).status).toBe("done");
  const feedback = await fetch(base + "/api/activities/124/feedback").then(r => r.json()) as any;
  expect(feedback.plan_date).toBe("2026-07-09");
  expect(feedback.prescribed_type).toBe("run");
  expect(feedback.prescribed_miles).toBe(3);
});

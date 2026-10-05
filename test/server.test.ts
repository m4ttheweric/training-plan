import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TEST_APP_ROOT lets this contract suite demonstrate failures against an old snapshot.
const root = process.env.TEST_APP_ROOT || join(import.meta.dir, "..");
let dir: string;
let base: string;
let proc: Bun.Subprocess;
let responsePath: string;
const goodOutput = JSON.stringify({ analysis: { key_findings: ["Even effort"] }, narrative: "A steady run." });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "training-server-test-"));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("test") });
  const port = probe.port;
  probe.stop(true);
  base = `http://127.0.0.1:${port}`;
  const bin = join(dir, ".local/bin");
  mkdirSync(bin, { recursive: true });
  responsePath = join(dir, "response.json");
  writeFileSync(responsePath, goodOutput);
  writeFileSync(join(bin, "claude"), '#!/bin/sh\ncat "$FAKE_CLAUDE_RESPONSE_FILE"\n');
  chmodSync(join(bin, "claude"), 0o755);
  const env = { ...process.env, HOME: dir, DATA_DIR: join(dir, "new/data"), PORT: String(port), HOST: "127.0.0.1", BASE_URL: "", PLAN_ID: "10k-oct-2026", FEEDBACK_ENABLED: "true", FEEDBACK_CLAUDE_ACCOUNT: "", STRAVA_CLIENT_ID: "", STRAVA_CLIENT_SECRET: "", STRAVA_ACCESS_TOKEN: "", STRAVA_REFRESH_TOKEN: "", FAKE_CLAUDE_RESPONSE_FILE: responsePath };
  const seed = Bun.spawnSync([process.execPath, "-e", `import { upsertActivity } from './src/db'; upsertActivity({id:123,name:'Test run',type:'Run',sport_type:'Run',distance:4828,moving_time:1800,start_date:'2026-07-06T12:00:00Z',start_date_local:'2026-07-06T07:00:00',average_speed:2.682});`], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
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
async function outcome() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const request = await fetch(base + "/api/activities/123/analyze").then(r => r.json()) as any;
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

test("CLI output is validated and stored against the prescribed run", async () => {
  expect((await post("/api/activities/123/analyze", { note: "Felt easy" })).status).toBe(202);
  expect((await outcome()).status).toBe("done");
  const feedback = await fetch(base + "/api/activities/123/feedback").then(r => r.json()) as any;
  expect(feedback.narrative).toBe("A steady run.");
  expect(feedback.plan_date).toBe("2026-07-06");
  expect(feedback.plan_id).toBe("10k-oct-2026");
  expect(feedback.prescribed_miles).toBe(3);
});

test("re-analysis requires confirmation and invalid output preserves old feedback", async () => {
  const confirmation = await post("/api/activities/123/analyze", {});
  expect(confirmation.status).toBe(409);
  expect((await confirmation.json() as any).requires_confirmation).toBe(true);
  writeFileSync(responsePath, "not JSON");
  expect((await post("/api/activities/123/analyze", { force: true })).status).toBe(202);
  expect((await outcome()).status).toBe("failed");
  expect((await fetch(base + "/api/activities/123/feedback").then(r => r.json()) as any).narrative).toBe("A steady run.");
});

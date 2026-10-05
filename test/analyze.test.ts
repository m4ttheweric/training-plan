import { expect, test, describe } from "bun:test";
import {
  buildAnalyzeCommand, buildAnalyzePrompt, buildSpawnEnv, decideAnalyzeRequest,
  resolveAccount, normalizeNote, getAnalysisAvailability, parseAnalysisOutput,
} from "../src/analyze";
import { resumeState } from "../public/analyze.js";

const OPTS = { date: "2026-08-03", note: null, context: { activity: { strava_id: 123 }, prescribed: { miles: 3 } } };

// Removing tool disabling would let model output mutate local data directly.
describe("portable optional analysis", () => {
  test("uses the authenticated Claude CLI without account switching by default", () => {
    expect(buildAnalyzeCommand(OPTS)[0]).toBe("claude");
    expect(resolveAccount({})).toBeUndefined();
    expect(resolveAccount({ FEEDBACK_CLAUDE_ACCOUNT: "" })).toBeUndefined();
  });
  test("uses cswap only for an explicitly pinned account", () => {
    expect(buildAnalyzeCommand({ ...OPTS, account: "runner@example.com" }).slice(0, 4))
      .toEqual(["cswap", "run", "runner@example.com", "--"]);
  });
  test.each(["1", "runner@example.com\0", "runner@example.com\u200b", "runner@example.com\u00ad"])("rejects invalid account %s", account => {
    expect(() => resolveAccount({ FEEDBACK_CLAUDE_ACCOUNT: account })).toThrow(/email/);
  });
  test("accepts accounts without author-specific employer restrictions", () => {
    expect(resolveAccount({ FEEDBACK_CLAUDE_ACCOUNT: "runner@company.example" })).toBe("runner@company.example");
  });
  test("disables tools and avoids bypassing permissions", () => {
    const cmd = buildAnalyzeCommand(OPTS);
    expect(cmd[cmd.indexOf("--tools") + 1]).toBe("");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });
  test("is disabled until explicitly enabled", () => {
    expect(getAnalysisAvailability({}, () => "/bin/claude").enabled).toBe(false);
  });
  test("reports missing CLI before attempting analysis", () => {
    expect(getAnalysisAvailability({ FEEDBACK_ENABLED: "true" }, () => null).available).toBe(false);
  });
  test("can run directly when Claude is installed", () => {
    expect(getAnalysisAvailability({ FEEDBACK_ENABLED: "true" }, () => "/bin/claude").available).toBe(true);
  });
  test("an explicit switched account requires cswap too", () => {
    expect(getAnalysisAvailability({ FEEDBACK_ENABLED: "true", FEEDBACK_CLAUDE_ACCOUNT: "runner@example.com" }, name => name === "claude" ? "/bin/claude" : null).available).toBe(false);
  });
  test("invalid account configuration yields an unavailable status", () => {
    expect(getAnalysisAvailability({ FEEDBACK_ENABLED: "true", FEEDBACK_CLAUDE_ACCOUNT: "1" }, () => "/bin/claude").available).toBe(false);
  });
});

describe("analysis prompt and result", () => {
  test("includes actual context and requests a structured response", () => {
    const prompt = buildAnalyzePrompt(OPTS);
    expect(prompt).toContain('"strava_id":123');
    expect(prompt).toContain('"miles":3');
    expect(prompt).toContain("2026-08-03");
    expect(prompt).toContain("narrative");
    expect(prompt).not.toContain("/matt:");
  });
  test("includes an athlete note as data", () => {
    expect(buildAnalyzePrompt({ ...OPTS, note: "scaled back" })).toContain("scaled back");
  });
  test("pins a model without silent fallback", () => {
    const cmd = buildAnalyzeCommand(OPTS);
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("opus");
    expect(cmd).not.toContain("--fallback-model");
  });
  test("parses structured analysis and narrative", () => {
    expect(parseAnalysisOutput('{"analysis":{"key_findings":["Even splits"]},"narrative":"Steady run."}'))
      .toEqual({ analysis: { key_findings: ["Even splits"] }, narrative: "Steady run." });
  });
  test("accepts a fenced JSON response", () => {
    expect(parseAnalysisOutput('```json\n{"analysis":{},"narrative":"Steady run."}\n```').narrative).toBe("Steady run.");
  });
  test.each(['garbage', '{}', '{"analysis":[],"narrative":"Run"}', '{"analysis":{},"narrative":""}'])("rejects unusable analysis %s", output => {
    expect(() => parseAnalysisOutput(output)).toThrow();
  });
});

describe("resumeState", () => {
  test("no prior request leaves the row idle", () => expect(resumeState(null).state).toBe("idle"));
  test("a running request is rejoined", () => expect(resumeState({ status: "running" }).state).toBe("running"));
  test("a completed request leaves the row idle", () => expect(resumeState({ status: "done" }).state).toBe("idle"));
  test("a failed request retains its error", () => {
    expect(resumeState({ status: "failed", error: "Session limit" })).toEqual({ state: "failed", error: "Session limit" });
  });
  test("an authentication error suggests re-login without assuming cswap", () => {
    expect(resumeState({ status: "failed", error: "refresh token expired" }).error).toMatch(/log in/i);
  });
});

describe("note normalization", () => {
  test("caps note length at 2000", () => {
    expect(normalizeNote("x".repeat(5000))!.length).toBe(2000);
  });

  test("returns null for blank and non-string input", () => {
    expect(normalizeNote("   ")).toBeNull();
    expect(normalizeNote(undefined)).toBeNull();
    expect(normalizeNote(42)).toBeNull();
  });
});

describe("spawn environment", () => {
  test("puts the home bin directories on PATH", () => {
    const env = buildSpawnEnv({ HOME: "/Users/matt", PATH: "/usr/bin:/bin" });
    const dirs = env.PATH.split(":");
    expect(dirs).toContain("/Users/matt/.local/bin");
    expect(dirs).toContain("/Users/matt/.bun/bin");
  });

  test("preserves the inherited PATH entries", () => {
    const env = buildSpawnEnv({ HOME: "/Users/matt", PATH: "/usr/bin:/bin" });
    const dirs = env.PATH.split(":");
    expect(dirs).toContain("/usr/bin");
    expect(dirs).toContain("/bin");
  });

  test("puts the home bin directories ahead of the inherited ones", () => {
    const env = buildSpawnEnv({ HOME: "/Users/matt", PATH: "/usr/bin" });
    const dirs = env.PATH.split(":");
    expect(dirs.indexOf("/Users/matt/.local/bin")).toBeLessThan(dirs.indexOf("/usr/bin"));
  });

  test("does not duplicate a directory already on PATH", () => {
    const env = buildSpawnEnv({ HOME: "/Users/matt", PATH: "/Users/matt/.local/bin:/usr/bin" });
    const dirs = env.PATH.split(":");
    expect(dirs.filter((d) => d === "/Users/matt/.local/bin").length).toBe(1);
  });

  test("survives a missing PATH and a missing HOME", () => {
    expect(buildSpawnEnv({ HOME: "/Users/matt" }).PATH).toContain("/Users/matt/.local/bin");
    expect(buildSpawnEnv({ PATH: "/usr/bin" }).PATH).toContain("/usr/bin");
  });

  test("carries other environment variables through", () => {
    expect(buildSpawnEnv({ HOME: "/h", PATH: "/usr/bin", FOO: "bar" }).FOO).toBe("bar");
  });
});

describe("analyze route guards", () => {
  const base = { activityType: "Run", hasFeedback: false, force: false, analyzing: false };

  test("allows a fresh run with no feedback", () => {
    expect(decideAnalyzeRequest(base)).toEqual({ ok: true });
  });

  test("rejects anything that is not a run", () => {
    const d = decideAnalyzeRequest({ ...base, activityType: "WeightTraining" });
    expect(d).toEqual({ ok: false, status: 404, body: { error: "Not a run" } });
  });

  test("rejects a missing activity", () => {
    expect(decideAnalyzeRequest({ ...base, activityType: null }).ok).toBe(false);
  });

  test("demands confirmation when feedback already exists", () => {
    const d = decideAnalyzeRequest({ ...base, hasFeedback: true });
    expect(d).toEqual({
      ok: false, status: 409,
      body: { error: "Feedback already exists", requires_confirmation: true },
    });
  });

  test("proceeds past the confirmation gate only with an explicit force", () => {
    expect(decideAnalyzeRequest({ ...base, hasFeedback: true, force: true })).toEqual({ ok: true });
  });

  test("rejects a concurrent analysis", () => {
    const d = decideAnalyzeRequest({ ...base, analyzing: true });
    expect(d).toEqual({ ok: false, status: 409, body: { error: "Analysis already in progress" } });
  });

  test("the confirmation gate is reached before the concurrency gate", () => {
    const d = decideAnalyzeRequest({ ...base, hasFeedback: true, analyzing: true });
    expect(d).toEqual({
      ok: false, status: 409,
      body: { error: "Feedback already exists", requires_confirmation: true },
    });
  });

  test("the not-a-run check precedes every other gate", () => {
    const d = decideAnalyzeRequest({
      activityType: "Ride", hasFeedback: true, force: false, analyzing: true,
    });
    expect(d).toEqual({ ok: false, status: 404, body: { error: "Not a run" } });
  });
});

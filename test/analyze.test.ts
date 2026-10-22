import { expect, test, describe } from "bun:test";
import {
  buildAnalyzeCommand, buildAnalyzePrompt, buildSpawnEnv, decideAnalyzeRequest, localApiUrl,
  resolveAccount, resolveModel, resolveEffort, resolveSkill, normalizeNote, getAnalysisAvailability, validateAnalysis,
} from "../src/analyze";
import { resumeState } from "../public/analyze.js";

const OPTS = { skill: "run-feedback", stravaId: 123, date: "2026-08-03", note: null, apiUrl: "http://127.0.0.1:8081", dbPath: "/srv/data/training.db" };

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
  // Safe mode would hide the feedback skill, so the allowlist is the boundary.
  test("allows only curl and sqlite3 and avoids bypassing permissions", () => {
    const cmd = buildAnalyzeCommand(OPTS);
    expect(cmd[cmd.indexOf("--allowedTools") + 1]).toBe("Bash(curl:*),Bash(sqlite3:*)");
    expect(cmd[cmd.indexOf("--disallowedTools") + 1]).toBe("mcp__*");
    expect(cmd).not.toContain("--safe-mode");
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
  test("invokes the configured skill for the run's date", () => {
    expect(buildAnalyzePrompt(OPTS).startsWith("/run-feedback 2026-08-03\n")).toBe(true);
    expect(buildAnalyzePrompt({ ...OPTS, skill: "matt:run-feedback" }).startsWith("/matt:run-feedback 2026-08-03\n")).toBe(true);
  });
  test("names the activity, the local API and the database", () => {
    const prompt = buildAnalyzePrompt(OPTS);
    expect(prompt).toContain("Activity: 123");
    expect(prompt).toContain("API: http://127.0.0.1:8081");
    expect(prompt).toContain("Database: /srv/data/training.db");
  });
  test("includes an athlete note as data", () => {
    expect(buildAnalyzePrompt({ ...OPTS, note: "scaled back" })).toContain("scaled back");
  });
  test("pins a model without silent fallback", () => {
    const cmd = buildAnalyzeCommand(OPTS);
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("opus");
    expect(cmd).not.toContain("--fallback-model");
  });
  test("uses the configured model when one is passed", () => {
    const cmd = buildAnalyzeCommand({ ...OPTS, model: "sonnet" });
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("sonnet");
  });
  test("defaults the model to opus when FEEDBACK_CLAUDE_MODEL is unset or blank", () => {
    expect(resolveModel({})).toBe("opus");
    expect(resolveModel({ FEEDBACK_CLAUDE_MODEL: "  " })).toBe("opus");
  });
  test("accepts a model alias or full model ID", () => {
    expect(resolveModel({ FEEDBACK_CLAUDE_MODEL: "sonnet" })).toBe("sonnet");
    expect(resolveModel({ FEEDBACK_CLAUDE_MODEL: "claude-opus-4-6[1m]" })).toBe("claude-opus-4-6[1m]");
  });
  test("omits --effort unless one is configured", () => {
    expect(buildAnalyzeCommand(OPTS)).not.toContain("--effort");
    expect(resolveEffort({ FEEDBACK_CLAUDE_EFFORT: " " })).toBeUndefined();
  });
  test("passes a configured effort level to the CLI", () => {
    const cmd = buildAnalyzeCommand({ ...OPTS, model: "claude-opus-5-5", effort: "low" });
    expect(cmd[cmd.indexOf("--effort") + 1]).toBe("low");
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  });
  test.each(["LOW", "extreme", "low --tools x"])("rejects invalid effort %s", effort => {
    expect(() => resolveEffort({ FEEDBACK_CLAUDE_EFFORT: effort })).toThrow(/FEEDBACK_CLAUDE_EFFORT/);
  });
  test.each(["-p", "sonnet --tools x", "son net"])("rejects invalid model %s", model => {
    expect(() => resolveModel({ FEEDBACK_CLAUDE_MODEL: model })).toThrow(/model/);
  });
  test("reports a rejected model as unavailable", () => {
    const status = getAnalysisAvailability({ FEEDBACK_ENABLED: "true", FEEDBACK_CLAUDE_MODEL: "-p" }, () => "/bin/claude");
    expect(status.available).toBe(false);
    expect(status.message).toMatch(/FEEDBACK_CLAUDE_MODEL/);
  });
  test("defaults the skill to the bundled run-feedback skill", () => {
    expect(resolveSkill({})).toBe("run-feedback");
    expect(resolveSkill({ FEEDBACK_SKILL: " " })).toBe("run-feedback");
  });
  test("accepts a plugin-qualified skill override", () => {
    expect(resolveSkill({ FEEDBACK_SKILL: "matt:run-feedback" })).toBe("matt:run-feedback");
  });
  test.each(["-p", "/run-feedback", "run feedback", "x\ny"])("rejects invalid skill %j", skill => {
    expect(() => resolveSkill({ FEEDBACK_SKILL: skill })).toThrow(/FEEDBACK_SKILL/);
  });
  test("reports a rejected skill as unavailable", () => {
    const status = getAnalysisAvailability({ FEEDBACK_ENABLED: "true", FEEDBACK_SKILL: "-p" }, () => "/bin/claude");
    expect(status.available).toBe(false);
    expect(status.message).toMatch(/FEEDBACK_SKILL/);
  });
});

describe("feedback validation", () => {
  test("accepts supported numeric metrics and findings", () => {
    const analysis = { baseline: { avg_hr: 140 }, deltas: { hr_vs_baseline: -1, pace_vs_baseline_s_per_mi: 0, feels_temp_vs_baseline_f: 5 }, cadence_spm: 170, key_findings: ["Even effort"] };
    expect(validateAnalysis(JSON.stringify(analysis))).toEqual(analysis);
  });
  test("accepts fields it does not know about", () => {
    expect(validateAnalysis('{"strides":{"top_speed_mps":6.42}}')).toEqual({ strides: { top_speed_mps: 6.42 } });
  });
  test.each([
    { deltas: { hr_vs_baseline: null } },
    { cadence_spm: { valueOf: 1, toString: 1 } },
    { baseline: [] }, { baseline: { avg_hr: "fast" } },
    { deltas: null }, { deltas: { pace_vs_baseline_s_per_mi: "12" } },
    { key_findings: [42] }, { key_findings: "Good" },
  ])("rejects malformed optional metrics %j", analysis => {
    expect(() => validateAnalysis(JSON.stringify(analysis))).toThrow();
  });
  test.each(["garbage", "[]", "null", "42"])("rejects analysis_json that is not an object: %s", text => {
    expect(() => validateAnalysis(text)).toThrow();
  });
});

describe("local API address", () => {
  test.each([["127.0.0.1", "http://127.0.0.1:8081"], ["0.0.0.0", "http://127.0.0.1:8081"], ["::", "http://127.0.0.1:8081"], ["localhost", "http://localhost:8081"], ["192.168.1.5", "http://192.168.1.5:8081"], ["::1", "http://[::1]:8081"]])(
    "reaches a server bound to %s at %s", (host, url) => {
      expect(localApiUrl(host, 8081)).toBe(url);
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

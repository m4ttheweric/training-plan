import { expect, test, describe } from "bun:test";
import {
  buildAnalyzeCommand, buildAnalyzePrompt, buildSpawnEnv, decideAnalyzeRequest, resolveAccount, normalizeNote,
  DEFAULT_ACCOUNT,
} from "../src/analyze";

const OPTS = { account: "goodwin.matthew.eric@gmail.com", date: "2026-08-03", note: null };

function allowedTools(): string {
  const cmd = buildAnalyzeCommand(OPTS);
  const i = cmd.indexOf("--allowedTools");
  expect(i).toBeGreaterThan(-1);
  return cmd[i + 1]!;
}

describe("tool permissions", () => {
  test("permits the curl calls the skill posts feedback with", () => {
    expect(allowedTools()).toMatch(/Bash\(curl:/);
  });

  test("permits the sqlite3 reads the readiness step needs", () => {
    expect(allowedTools()).toMatch(/sqlite3/);
  });

  test("never bypasses permissions wholesale", () => {
    expect(buildAnalyzeCommand(OPTS)).not.toContain("--dangerously-skip-permissions");
  });
});
describe("model pinning", () => {
  test("always pins opus", () => {
    const cmd = buildAnalyzeCommand(OPTS);
    const i = cmd.indexOf("--model");
    expect(i).toBeGreaterThan(-1);
    expect(cmd[i + 1]).toBe("opus");
  });

  test("never emits --fallback-model", () => {
    expect(buildAnalyzeCommand(OPTS)).not.toContain("--fallback-model");
  });
});

describe("account pinning", () => {
  test("rejects the assured work account", () => {
    expect(() => resolveAccount({ FEEDBACK_CLAUDE_ACCOUNT: "matthew.goodwin@assured.claims" }))
      .toThrow(/work account/i);
  });

  test("rejects any assured.claims address", () => {
    expect(() => resolveAccount({ FEEDBACK_CLAUDE_ACCOUNT: "someone.else@assured.claims" }))
      .toThrow(/work account/i);
  });

  test("rejects a bare slot number, which could resolve to the work account", () => {
    expect(() => resolveAccount({ FEEDBACK_CLAUDE_ACCOUNT: "1" })).toThrow(/email/i);
  });

  test("rejects a blank override", () => {
    expect(() => resolveAccount({ FEEDBACK_CLAUDE_ACCOUNT: "   " })).toThrow();
  });

  test("returns the override when set", () => {
    expect(resolveAccount({ FEEDBACK_CLAUDE_ACCOUNT: "other@gmail.com" })).toBe("other@gmail.com");
  });

  test("falls back to the personal default", () => {
    expect(resolveAccount({})).toBe(DEFAULT_ACCOUNT);
  });

  test("the default is not a work account", () => {
    expect(DEFAULT_ACCOUNT).not.toMatch(/assured\.claims/i);
  });

  test("buildAnalyzeCommand independently rejects the work account", () => {
    expect(() => buildAnalyzeCommand({ ...OPTS, account: "matthew.goodwin@assured.claims" }))
      .toThrow(/work account/i);
  });

  test("the cswap subcommand is always run", () => {
    const cmd = buildAnalyzeCommand(OPTS);
    expect(cmd[0]).toBe("cswap");
    expect(cmd[1]).toBe("run");
  });

  test("rejects the work account with a trailing NUL byte", () => {
    expect(() => resolveAccount({ FEEDBACK_CLAUDE_ACCOUNT: "matthew.goodwin@assured.claims\0" })).toThrow();
  });

  test("rejects the work account with a trailing zero width space", () => {
    expect(() => resolveAccount({ FEEDBACK_CLAUDE_ACCOUNT: "matthew.goodwin@assured.claims​" })).toThrow();
  });

  test("rejects the work account with a trailing soft hyphen", () => {
    expect(() => resolveAccount({ FEEDBACK_CLAUDE_ACCOUNT: "matthew.goodwin@assured.claims­" })).toThrow();
  });

  test("buildAnalyzeCommand rejects a work account with invisible trailing characters", () => {
    expect(() => buildAnalyzeCommand({
      account: "matthew.goodwin@assured.claims​", date: "2026-08-03", note: null,
    })).toThrow();
  });

  test("still accepts a normal personal address", () => {
    expect(resolveAccount({ FEEDBACK_CLAUDE_ACCOUNT: "goodwin.matthew.eric@gmail.com" }))
      .toBe("goodwin.matthew.eric@gmail.com");
  });

  test("does not pass a literal claude argument, which cswap supplies itself", () => {
    const cmd = buildAnalyzeCommand(OPTS);
    expect(cmd).not.toContain("claude");
  });

  test("the argument after the -- separator is a flag, not a binary name", () => {
    const cmd = buildAnalyzeCommand(OPTS);
    const sep = cmd.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    expect(cmd[sep + 1]!.startsWith("-")).toBe(true);
  });
});

describe("prompt shaping", () => {
  test("includes the date", () => {
    expect(buildAnalyzePrompt("2026-08-03", null)).toContain("2026-08-03");
  });

  test("invokes the skill by its slash command", () => {
    expect(buildAnalyzePrompt("2026-08-03", null)).toBe("/matt:run-feedback 2026-08-03");
  });

  test("includes the note text when given", () => {
    expect(buildAnalyzePrompt("2026-08-03", "mild virus, scaled back"))
      .toContain("mild virus, scaled back");
  });

  test("omits the note paragraph when null", () => {
    expect(buildAnalyzePrompt("2026-08-03", null)).not.toContain("Additional context");
  });

  test("omits the note paragraph when whitespace only", () => {
    expect(buildAnalyzePrompt("2026-08-03", "   ")).not.toContain("Additional context");
  });

  test("the note reaches the built command", () => {
    const cmd = buildAnalyzeCommand({ ...OPTS, note: "mild virus" });
    expect(cmd.join(" ")).toContain("mild virus");
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

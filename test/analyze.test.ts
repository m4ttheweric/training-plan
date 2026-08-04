import { expect, test, describe } from "bun:test";
import {
  buildAnalyzeCommand, buildAnalyzePrompt, resolveAccount, normalizeNote,
  DEFAULT_ACCOUNT,
} from "../src/analyze";

const OPTS = { account: "goodwin.matthew.eric@gmail.com", date: "2026-08-03", note: null };

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
    expect(() => resolveAccount({ FEEDBACK_CLAUDE_ACCOUNT: "matthew.goodwin@assured.claims " })).toThrow();
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
});

describe("prompt shaping", () => {
  test("includes the date", () => {
    expect(buildAnalyzePrompt("2026-08-03", null)).toContain("2026-08-03");
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

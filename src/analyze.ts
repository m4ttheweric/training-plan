/* Command construction for the app-triggered run-feedback spawn.
 *
 * Pure and I/O free, so the constraints below are unit-testable without
 * spawning anything. They are not stylistic:
 *
 *   Opus is pinned explicitly and --fallback-model is never emitted, because a
 *   silent downgrade to a cheaper tier on a numbers-dense analysis is hard to
 *   notice after the fact.
 *
 *   The account is pinned by email and validated against the work account,
 *   because `cswap auto` rotates on rate limits and could otherwise land on
 *   that account mid-flight. Slot numbers are rejected outright: slot 1 IS the
 *   work account, so accepting "1" would defeat the check.
 */

export const ASSURED_ACCOUNT_PATTERN = /assured\.claims$/i;
export const DEFAULT_ACCOUNT = "goodwin.matthew.eric@gmail.com";
export const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_NOTE_LENGTH = 2000;

function assertPersonalAccount(account: string): string {
  const a = account.trim();
  if (!a) throw new Error("No Claude account configured for analysis");
  if (!a.includes("@"))
    throw new Error(`Account must be pinned by email, not a slot number: ${a}`);
  if (ASSURED_ACCOUNT_PATTERN.test(a))
    throw new Error(`Refusing to run analysis under the work account: ${a}`);
  return a;
}

export function resolveAccount(env: Record<string, string | undefined>): string {
  return assertPersonalAccount(env.FEEDBACK_CLAUDE_ACCOUNT ?? DEFAULT_ACCOUNT);
}

export function normalizeNote(note: unknown): string | null {
  if (typeof note !== "string") return null;
  const trimmed = note.trim();
  return trimmed ? trimmed.slice(0, MAX_NOTE_LENGTH) : null;
}

export function buildAnalyzePrompt(date: string, note: string | null): string {
  const base = `/matt:run-feedback ${date}`;
  const clean = normalizeNote(note);
  return clean ? `${base}\n\nAdditional context from the athlete: ${clean}` : base;
}

/* --allowedTools is scoped to curl rather than bypassing permissions outright,
   because the skill's only side effects are curl calls to the local API. */
export function buildAnalyzeCommand(
  opts: { account: string; date: string; note: string | null },
): string[] {
  const account = assertPersonalAccount(opts.account);
  return [
    "cswap", "run", account, "--",
    "claude", "--model", "opus",
    "--allowedTools", "Bash(curl:*)",
    "-p", buildAnalyzePrompt(opts.date, opts.note),
  ];
}

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
/* A positive allowlist, not a blocklist. Rejecting only known-bad patterns
   loses to the next invisible character or unicode lookalike; requiring a
   conservative email shape rejects NUL, zero-width space, soft hyphen and
   friends in one move, and subsumes the "must contain @" check. */
export const ACCOUNT_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export const DEFAULT_ACCOUNT = "goodwin.matthew.eric@gmail.com";
export const ANALYZE_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_NOTE_LENGTH = 2000;

function assertPersonalAccount(account: string): string {
  const a = account.trim();
  if (!a) throw new Error("No Claude account configured for analysis");
  if (!ACCOUNT_PATTERN.test(a))
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
/* cswap run <account> -- <args> invokes claude itself and appends these
   args, so passing a literal "claude" here would be consumed as a
   positional prompt and would silently mangle the real prompt. */
export function buildAnalyzeCommand(
  opts: { account: string; date: string; note: string | null },
): string[] {
  const account = assertPersonalAccount(opts.account);
  return [
    "cswap", "run", account, "--",
    "--model", "opus",
    "--allowedTools", "Bash(curl:*)",
    "-p", buildAnalyzePrompt(opts.date, opts.note),
  ];
}

/* The launchd service runs `bun src/server.ts` directly rather than
   start-server.sh, so it inherits a bare PATH of /usr/bin:/bin:/usr/sbin:/sbin
   and cannot see cswap or claude in ~/.local/bin. Rather than depend on how
   the server happened to be launched, the spawn builds its own PATH. */
export const SPAWN_PATH_PREFIXES = [".local/bin", ".bun/bin"];
export const SPAWN_PATH_SYSTEM = ["/opt/homebrew/bin", "/usr/local/bin"];

export type AnalyzeDecision =
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> };

/* The analyze route's guard ordering, extracted so it can be tested without a
   live server. Order matters: re-analysis overwrites an existing analysis, so
   the confirmation gate must be reached before anything else can short
   circuit it away. */
export function decideAnalyzeRequest(input: {
  activityType: string | null | undefined;
  hasFeedback: boolean;
  force: boolean;
  analyzing: boolean;
}): AnalyzeDecision {
  if (input.activityType !== "Run")
    return { ok: false, status: 404, body: { error: "Not a run" } };
  if (input.hasFeedback && input.force !== true)
    return { ok: false, status: 409, body: { error: "Feedback already exists", requires_confirmation: true } };
  if (input.analyzing)
    return { ok: false, status: 409, body: { error: "Analysis already in progress" } };
  return { ok: true };
}

export function buildSpawnEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const home = (env.HOME ?? "").trim();
  const homeDirs = home ? SPAWN_PATH_PREFIXES.map((p) => `${home}/${p}`) : [];
  const current = (env.PATH ?? "").split(":");
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...homeDirs, ...SPAWN_PATH_SYSTEM, ...current]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  out.PATH = merged.join(":");
  return out;
}

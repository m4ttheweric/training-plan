/* Browser-only helpers for the app-triggered run analysis.
 *
 * Same rule as sync.js: lib.js is imported by the server and by bun test, so
 * anything touching fetch lives here instead. This module owns the network
 * state machine only. entry.html owns every bit of rendering.
 */

/* The server's real backstop is 5 minutes to SIGTERM, plus a 10s SIGKILL
   grace, plus a 20s release grace: 5 min 30s worst case. 120 attempts at 3s
   (6 minutes) leaves a 30 second margin past that, rather than giving up
   while the subprocess could still be alive. */
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 120;

/* Resolves { needsConfirm: true } when the run already has feedback and no
   force was sent. The caller shows the overwrite dialog and calls again with
   force: true. */
export async function requestAnalysis(id, { note = "", force = false } = {}) {
  const res = await fetch("/api/activities/" + id + "/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note, force }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409 && body.requires_confirmation) return { needsConfirm: true };
  if (!res.ok) throw new Error(body.error || "Could not start the analysis.");
  return { started: true, requestId: body.request_id };
}

export async function pollAnalysis(id) {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const request = await fetch("/api/activities/" + id + "/analyze")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (request && request.status !== "running") return request;
  }
  return { status: "failed", error: "Timed out waiting for the analysis." };
}

/* What the analyze row should show for the latest request when the page loads.
   A failed request has to keep its error: the API still reports the failure,
   so resetting to a fresh Analyze button hides an outcome the server knows. */
export function resumeState(request) {
  if (!request) return { state: "idle" };
  if (request.status === "running") return { state: "running" };
  if (request.status === "failed") return { state: "failed", error: friendlyError(request.error) };
  return { state: "idle" };
}

/* A dead cswap refresh token is a live scenario, so name the fix instead of
   dumping raw stderr at the reader. */
export function friendlyError(message) {
  if (/re-login|refresh token/i.test(message || ""))
    return "Account needs re-login. Run: cswap add";
  return message || "The analysis failed.";
}

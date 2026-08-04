/* Browser-only sync helpers shared by Today, Journal and Plan.
 *
 * Not part of lib.js: lib.js is imported by the server and by bun test, so
 * it must stay free of DOM and fetch. This file uses fetch and setTimeout
 * and is loaded only by <script type="module"> in the HTML pages.
 */

/* POST /api/sync starts the pull in the background and returns immediately,
   so callers that need to know when it's done poll GET /api/status until
   its "syncing" flag clears. Bounded so a stuck sync does not poll forever. */
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 60;

export async function waitForSyncDone() {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const status = await fetch("/api/status").then((r) => r.json()).catch(() => ({ syncing: true }));
    if (!status.syncing) return;
  }
}

/* A manual sync always runs -- the person on the page explicitly asked for
   one, so there is no throttle to check. */
export async function manualSync() {
  const res = await fetch("/api/sync", { method: "POST" });
  if (!res.ok && res.status !== 409) throw new Error("Sync failed to start");
  await waitForSyncDone();
}

/* An automatic, page-load-triggered sync. The server throttles these (see
   AUTO_SYNC_MIN_INTERVAL_MS in src/server.ts) so loading Today, Journal and
   Plan in quick succession does not fire a real Strava pull from each one --
   a throttled call comes back as `{ skipped: true }` immediately, and a
   sync already in flight from another page comes back as 409. Either way
   this resolves `{ ran: false }` so the caller knows its already-rendered
   data is still current and there is nothing to re-fetch. `{ ran: true }`
   means this call actually triggered a sync and it has now finished. */
export async function autoSync() {
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto: true }),
    });
    if (res.status === 409) return { ran: false };
    const body = await res.json();
    if (body.skipped) return { ran: false };
    await waitForSyncDone();
    return { ran: true };
  } catch {
    return { ran: false };
  }
}

# Run Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-mile split collection during Strava sync, on-demand LLM narrative feedback via a Claude Code skill, and expandable detail views on both the plan and activities pages.

**Architecture:** Three layers -- (1) sync fetches Strava detail endpoint for mile splits and stores in `activity_splits` table, (2) a `mattstack:run-feedback` skill generates structured analysis + narrative and POSTs to the app, (3) both HTML pages get click-to-expand rows showing split tables and optional narrative cards. Data fetched on demand per click, not bulk-loaded.

**Tech Stack:** Bun (runtime), bun:sqlite (DB), Strava API v3 (detail endpoint for splits), vanilla JS (frontend), Claude Code skill (LLM analysis)

## Global Constraints

- Runtime: Bun 1.3+, no npm dependencies
- DB: SQLite via `bun:sqlite`, WAL mode, synchronous API (no async DB calls)
- Strava rate limits: 100 req/15 min, 1000/day. One extra detail call per new run is fine.
- Frontend: vanilla JS, no framework. Match existing design system (CSS vars, font-display, font-body).
- Plan JSON files are read-only prescription data -- never write feedback into them.
- The skill lives in mattstack repo at `skills/infra/run-feedback/` and symlinks to `~/.claude/skills/mattstack:run-feedback/`.

---

### Task 1: DB schema and split storage functions

**Files:**
- Modify: `src/db.ts` (add table creation, split insert/query, feedback insert/query)

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `getSplitsForActivity(stravaId: number): SplitRow[]`
  - `hasSplitsForActivity(stravaId: number): boolean`
  - `insertSplits(stravaId: number, splits: StravaSplit[]): void`
  - `getRunsMissingSplits(): Array<{ strava_id: number }>`
  - `getFeedbackForActivity(stravaId: number): FeedbackRow | null`
  - `upsertFeedback(stravaId: number, feedback: FeedbackInput): void`
  - `updateActivityDetail(stravaId: number, detail: { calories?: number; suffer_score?: number; description?: string }): void`

- [ ] **Step 1: Add table creation for `activity_splits` and `run_feedback`**

In `src/db.ts`, add after the existing `ALTER TABLE` migration block:

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS activity_splits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_strava_id INTEGER NOT NULL,
    split_index INTEGER NOT NULL,
    distance REAL NOT NULL,
    elapsed_time INTEGER NOT NULL,
    moving_time INTEGER NOT NULL,
    elevation_diff REAL,
    average_speed REAL,
    average_heartrate REAL,
    pace_zone INTEGER,
    UNIQUE(activity_strava_id, split_index)
  );
  CREATE INDEX IF NOT EXISTS idx_splits_activity ON activity_splits(activity_strava_id);

  CREATE TABLE IF NOT EXISTS run_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_strava_id INTEGER NOT NULL UNIQUE,
    plan_date TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    prescribed_type TEXT NOT NULL,
    prescribed_miles REAL,
    analysis_json TEXT NOT NULL,
    narrative TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
```

- [ ] **Step 2: Add split storage functions**

```typescript
interface StravaSplit {
  distance: number;
  elapsed_time: number;
  moving_time: number;
  elevation_difference: number;
  average_speed: number;
  average_heartrate: number | null;
  pace_zone: number;
}

interface SplitRow {
  split_index: number;
  distance: number;
  elapsed_time: number;
  moving_time: number;
  elevation_diff: number | null;
  average_speed: number | null;
  average_heartrate: number | null;
  pace_zone: number | null;
}

export function hasSplitsForActivity(stravaId: number): boolean {
  const row = db.query("SELECT 1 FROM activity_splits WHERE activity_strava_id = ? LIMIT 1").get(stravaId);
  return !!row;
}

export function insertSplits(stravaId: number, splits: StravaSplit[]): void {
  const stmt = db.query(`
    INSERT OR IGNORE INTO activity_splits
      (activity_strava_id, split_index, distance, elapsed_time, moving_time, elevation_diff, average_speed, average_heartrate, pace_zone)
    VALUES ($id, $idx, $dist, $elapsed, $moving, $elev, $speed, $hr, $zone)
  `);
  for (let i = 0; i < splits.length; i++) {
    const s = splits[i];
    stmt.run({
      $id: stravaId, $idx: i,
      $dist: s.distance, $elapsed: s.elapsed_time, $moving: s.moving_time,
      $elev: s.elevation_difference ?? null, $speed: s.average_speed ?? null,
      $hr: s.average_heartrate ?? null, $zone: s.pace_zone ?? null,
    });
  }
}

export function getSplitsForActivity(stravaId: number): SplitRow[] {
  return db.query(`
    SELECT split_index, distance, elapsed_time, moving_time, elevation_diff, average_speed, average_heartrate, pace_zone
    FROM activity_splits WHERE activity_strava_id = ? ORDER BY split_index
  `).all(stravaId) as SplitRow[];
}

export function getRunsMissingSplits(): Array<{ strava_id: number }> {
  return db.query(`
    SELECT a.strava_id FROM activities a
    LEFT JOIN activity_splits s ON a.strava_id = s.activity_strava_id
    WHERE a.type = 'Run' AND s.id IS NULL AND a.distance > 0
    GROUP BY a.strava_id
  `).all() as Array<{ strava_id: number }>;
}
```

- [ ] **Step 3: Add feedback storage functions**

```typescript
interface FeedbackRow {
  activity_strava_id: number;
  plan_date: string;
  plan_id: string;
  prescribed_type: string;
  prescribed_miles: number | null;
  analysis_json: string;
  narrative: string;
  created_at: string;
}

interface FeedbackInput {
  plan_date: string;
  plan_id: string;
  prescribed_type: string;
  prescribed_miles: number | null;
  analysis_json: string;
  narrative: string;
}

export function getFeedbackForActivity(stravaId: number): FeedbackRow | null {
  return db.query(`
    SELECT activity_strava_id, plan_date, plan_id, prescribed_type, prescribed_miles, analysis_json, narrative, created_at
    FROM run_feedback WHERE activity_strava_id = ?
  `).get(stravaId) as FeedbackRow | null;
}

export function upsertFeedback(stravaId: number, feedback: FeedbackInput): void {
  db.query(`
    INSERT INTO run_feedback (activity_strava_id, plan_date, plan_id, prescribed_type, prescribed_miles, analysis_json, narrative)
    VALUES ($id, $date, $plan, $type, $miles, $json, $narrative)
    ON CONFLICT(activity_strava_id) DO UPDATE SET
      plan_date = $date, plan_id = $plan, prescribed_type = $type, prescribed_miles = $miles,
      analysis_json = $json, narrative = $narrative, created_at = datetime('now')
  `).run({
    $id: stravaId, $date: feedback.plan_date, $plan: feedback.plan_id,
    $type: feedback.prescribed_type, $miles: feedback.prescribed_miles ?? null,
    $json: feedback.analysis_json, $narrative: feedback.narrative,
  });
}
```

- [ ] **Step 4: Add detail backfill function**

```typescript
export function updateActivityDetail(stravaId: number, detail: { calories?: number; suffer_score?: number; description?: string }): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { $id: stravaId };
  if (detail.calories != null) { sets.push("calories = COALESCE(calories, $cal)"); params.$cal = detail.calories; }
  if (detail.suffer_score != null) { sets.push("suffer_score = COALESCE(suffer_score, $ss)"); params.$ss = detail.suffer_score; }
  if (detail.description != null) { sets.push("description = COALESCE(description, $desc)"); params.$desc = detail.description; }
  if (!sets.length) return;
  db.query(`UPDATE activities SET ${sets.join(", ")} WHERE strava_id = $id`).run(params);
}
```

- [ ] **Step 5: Verify tables are created**

Run: `cd /Users/matt/Documents/GitHub/training-plan && bun run src/db.ts`

Expected: no errors, tables created. Verify with:
```bash
sqlite3 data/training.db ".tables" | grep -E "activity_splits|run_feedback"
```
Expected output includes `activity_splits` and `run_feedback`.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts
git commit -m "feat: add activity_splits and run_feedback tables with storage functions"
```

---

### Task 2: Fetch splits during Strava sync

**Files:**
- Modify: `src/strava/sync.ts`

**Interfaces:**
- Consumes: `stravaGet` from `../strava/client`, `hasSplitsForActivity`, `insertSplits`, `getRunsMissingSplits`, `updateActivityDetail` from `../db`
- Produces: splits populated in DB for all synced runs

- [ ] **Step 1: Add detail fetch and split storage after the upsert loop**

In `src/strava/sync.ts`, add the `backfillSplits` function and call it after `backfillWeather()`:

```typescript
import { hasSplitsForActivity, insertSplits, getRunsMissingSplits, updateActivityDetail } from "../db";

interface StravaDetailActivity {
  splits_standard?: Array<{
    distance: number;
    elapsed_time: number;
    moving_time: number;
    elevation_difference: number;
    average_speed: number;
    average_heartrate: number | null;
    pace_zone: number;
  }>;
  calories?: number;
  suffer_score?: number;
  description?: string;
}

async function backfillSplits() {
  const missing = getRunsMissingSplits();
  if (!missing.length) return { updated: 0 };

  let updated = 0;
  for (const { strava_id } of missing) {
    try {
      const detail = await stravaGet<StravaDetailActivity>(`/activities/${strava_id}`);
      if (detail.splits_standard?.length) {
        insertSplits(strava_id, detail.splits_standard);
        updated++;
      }
      updateActivityDetail(strava_id, {
        calories: detail.calories,
        suffer_score: detail.suffer_score,
        description: detail.description,
      });
    } catch (e) {
      console.error(`Split fetch failed for activity ${strava_id}:`, e);
    }
  }

  console.log(`Splits backfilled for ${updated}/${missing.length} runs`);
  return { updated, total: missing.length };
}
```

- [ ] **Step 2: Call `backfillSplits()` in `syncActivities`**

After the existing `await backfillWeather();` line, add:

```typescript
  await backfillSplits();
```

- [ ] **Step 3: Test the sync**

Restart the server and trigger a sync:
```bash
curl -s -X POST "https://training.localhost/api/sync" | python3 -m json.tool
```

Then verify splits were stored:
```bash
sqlite3 /Users/matt/Documents/GitHub/training-plan/data/training.db "SELECT activity_strava_id, COUNT(*) as splits FROM activity_splits GROUP BY activity_strava_id"
```

Expected: each run activity should have 2-6 split rows (one per mile).

- [ ] **Step 4: Commit**

```bash
git add src/strava/sync.ts
git commit -m "feat: fetch per-mile splits from Strava detail endpoint during sync"
```

---

### Task 3: API endpoints for splits and feedback

**Files:**
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `getSplitsForActivity`, `getFeedbackForActivity`, `upsertFeedback` from `./db`
- Produces:
  - `GET /api/activities/:stravaId/splits` -> `{ splits: SplitRow[] }` or 404
  - `GET /api/activities/:stravaId/feedback` -> `FeedbackRow` or 404
  - `POST /api/activities/:stravaId/feedback` -> `{ ok: true }`

- [ ] **Step 1: Add imports and route handlers**

In `src/server.ts`, add to the imports:

```typescript
import { getSplitsForActivity, getFeedbackForActivity, upsertFeedback } from "./db";
```

Add these routes after the existing `PUT /api/activities/:stravaId/name` handler (before the `/api/plans` route):

```typescript
    const splitsMatch = path.match(/^\/api\/activities\/(\d+)\/splits$/);
    if (splitsMatch && req.method === "GET") {
      const stravaId = Number(splitsMatch[1]);
      const splits = getSplitsForActivity(stravaId);
      if (!splits.length) return json({ error: "No splits found" }, 404);
      return json({ splits });
    }

    const feedbackGetMatch = path.match(/^\/api\/activities\/(\d+)\/feedback$/);
    if (feedbackGetMatch && req.method === "GET") {
      const stravaId = Number(feedbackGetMatch[1]);
      const feedback = getFeedbackForActivity(stravaId);
      if (!feedback) return json({ error: "No feedback found" }, 404);
      return json(feedback);
    }

    const feedbackPostMatch = path.match(/^\/api\/activities\/(\d+)\/feedback$/);
    if (feedbackPostMatch && req.method === "POST") {
      const stravaId = Number(feedbackPostMatch[1]);
      try {
        const body = await req.json() as {
          plan_date: string; plan_id: string;
          prescribed_type: string; prescribed_miles: number | null;
          analysis_json: string; narrative: string;
        };
        upsertFeedback(stravaId, body);
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }
```

- [ ] **Step 2: Consolidate the regex matches for the same path pattern**

The GET and POST for `/api/activities/:stravaId/feedback` share a regex. Consolidate into one match block with method dispatch:

```typescript
    const feedbackMatch = path.match(/^\/api\/activities\/(\d+)\/feedback$/);
    if (feedbackMatch) {
      const stravaId = Number(feedbackMatch[1]);
      if (req.method === "GET") {
        const feedback = getFeedbackForActivity(stravaId);
        if (!feedback) return json({ error: "No feedback found" }, 404);
        return json(feedback);
      }
      if (req.method === "POST") {
        try {
          const body = await req.json() as {
            plan_date: string; plan_id: string;
            prescribed_type: string; prescribed_miles: number | null;
            analysis_json: string; narrative: string;
          };
          upsertFeedback(stravaId, body);
          return json({ ok: true });
        } catch (e) {
          return json({ error: String(e) }, 500);
        }
      }
    }
```

- [ ] **Step 3: Test the endpoints**

Restart the server and test (assuming sync has already populated splits):

```bash
# Get a run's strava_id
STRAVA_ID=$(sqlite3 /Users/matt/Documents/GitHub/training-plan/data/training.db "SELECT strava_id FROM activities WHERE type='Run' ORDER BY start_date_local DESC LIMIT 1")

# Test splits endpoint
curl -s "https://training.localhost/api/activities/$STRAVA_ID/splits" | python3 -m json.tool

# Test feedback 404 (no feedback yet)
curl -s "https://training.localhost/api/activities/$STRAVA_ID/feedback"
# Expected: {"error":"No feedback found"} with 404

# Test posting feedback
curl -s -X POST "https://training.localhost/api/activities/$STRAVA_ID/feedback" \
  -H "Content-Type: application/json" \
  -d '{"plan_date":"2026-07-09","plan_id":"10k-oct-2026","prescribed_type":"easy","prescribed_miles":3,"analysis_json":"{}","narrative":"test"}'
# Expected: {"ok":true}

# Test getting it back
curl -s "https://training.localhost/api/activities/$STRAVA_ID/feedback" | python3 -m json.tool
```

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: add splits and feedback API endpoints"
```

---

### Task 4: Expandable split detail on the activities page

**Files:**
- Modify: `public/activities.html`

**Interfaces:**
- Consumes: `GET /api/activities/:stravaId/splits`, `GET /api/activities/:stravaId/feedback`
- Produces: click-to-expand rows showing split table + optional narrative

- [ ] **Step 1: Add CSS for the detail row**

In the `<style>` block of `activities.html`, add before the closing `</style>`:

```css
  .detail-row td { padding: 0; border-bottom: 1px solid var(--grid); }
  .detail-content {
    padding: 16px 24px;
    background: var(--card); border-top: 1px solid var(--card-border);
  }
  .split-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 12px; }
  .split-table th {
    text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--ink-muted); font-weight: 500; padding: 4px 8px; border-bottom: 1px solid var(--grid);
  }
  .split-table th.num { text-align: right; }
  .split-table td { padding: 6px 8px; border-bottom: 1px solid var(--grid); font-variant-numeric: tabular-nums; }
  .split-table td.num { text-align: right; }
  .split-table tr:last-child td { border-bottom: none; }
  .narrative-card {
    background: var(--surface); border: 1px solid var(--card-border); border-radius: 6px;
    padding: 16px; font-size: 13px; line-height: 1.6; color: var(--ink-secondary);
    white-space: pre-wrap;
  }
  .narrative-card strong { color: var(--ink-primary); }
  tbody tr.run-row { cursor: pointer; }
  tbody tr.run-row:hover { background: var(--blue-light); }
  tbody tr.expanded { background: var(--blue-light); }
```

- [ ] **Step 2: Add helper functions for split rendering**

In the `<script>` block, add after the existing helper functions (after `typeBadge`):

```javascript
  function splitPace(speedMs) {
    if (!speedMs) return '--';
    const paceMin = 1609.34 / speedMs / 60;
    const m = Math.floor(paceMin);
    const s = Math.round((paceMin - m) * 60);
    return m + ':' + String(s).padStart(2, '0') + '/mi';
  }

  function elevFt(meters) {
    if (meters == null) return '--';
    const ft = meters * 3.281;
    return (ft >= 0 ? '+' : '') + Math.round(ft) + ' ft';
  }

  function renderSplitTable(splits) {
    let html = '<table class="split-table"><thead><tr>';
    html += '<th>Mile</th><th class="num">Pace</th><th class="num">HR</th><th class="num">Elev</th><th class="num">Zone</th>';
    html += '</tr></thead><tbody>';
    for (const s of splits) {
      html += '<tr>';
      html += '<td>' + (s.split_index + 1) + '</td>';
      html += '<td class="num">' + splitPace(s.average_speed) + '</td>';
      html += '<td class="num">' + (s.average_heartrate ? Math.round(s.average_heartrate) : '--') + '</td>';
      html += '<td class="num">' + elevFt(s.elevation_diff) + '</td>';
      html += '<td class="num">' + (s.pace_zone || '--') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  let expandedRow = null;

  async function toggleDetail(tr, stravaId) {
    const existing = tr.nextElementSibling;
    if (existing && existing.classList.contains('detail-row')) {
      existing.remove();
      tr.classList.remove('expanded');
      expandedRow = null;
      return;
    }

    if (expandedRow) {
      const prev = expandedRow.nextElementSibling;
      if (prev && prev.classList.contains('detail-row')) prev.remove();
      expandedRow.classList.remove('expanded');
    }

    const detailTr = document.createElement('tr');
    detailTr.className = 'detail-row';
    const td = document.createElement('td');
    td.colSpan = 8;
    td.innerHTML = '<div class="detail-content"><p style="color:var(--ink-muted);font-size:12px;">Loading splits...</p></div>';
    detailTr.appendChild(td);
    tr.after(detailTr);
    tr.classList.add('expanded');
    expandedRow = tr;

    try {
      const splitsRes = await fetch('/api/activities/' + stravaId + '/splits');
      let html = '';
      if (splitsRes.ok) {
        const data = await splitsRes.json();
        html += renderSplitTable(data.splits);
      } else {
        html += '<p style="color:var(--ink-muted);font-size:12px;">No split data available.</p>';
      }

      const fbRes = await fetch('/api/activities/' + stravaId + '/feedback');
      if (fbRes.ok) {
        const fb = await fbRes.json();
        html += '<div class="narrative-card">' + fb.narrative.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') + '</div>';
      }

      td.innerHTML = '<div class="detail-content">' + html + '</div>';
    } catch (e) {
      td.innerHTML = '<div class="detail-content"><p style="color:var(--accent);">Failed to load details.</p></div>';
    }
  }
```

- [ ] **Step 3: Make run rows clickable**

In the `loadActivities` function, modify the row rendering to add the `run-row` class and `data-strava-id` for runs:

Replace the `tableEl.innerHTML = activities.map(a => ...)` block. Change the opening `<tr>` tag:

```javascript
    tableEl.innerHTML = activities.map(a => `
      <tr${a.type === 'Run' && a.distance > 0 ? ' class="run-row" data-strava-id="' + a.strava_id + '"' : ''}>
```

After the existing `tableEl.querySelectorAll('.edit-btn')` event listener block, add:

```javascript
    tableEl.querySelectorAll('.run-row').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('.name-cell') || e.target.closest('.edit-btn') || e.target.tagName === 'A' || e.target.tagName === 'INPUT') return;
        toggleDetail(tr, tr.dataset.stravaId);
      });
    });
```

- [ ] **Step 4: Test in browser**

Open `https://training.localhost/activities.html`. Click a run row. Verify:
- Split table appears below with mile-by-mile data (pace, HR, elevation, zone)
- Clicking the same row collapses it
- Clicking a different run collapses the first and expands the new one
- Non-run rows (lifts, walks) are not clickable
- Edit button and Strava link still work without triggering expand

- [ ] **Step 5: Commit**

```bash
git add public/activities.html
git commit -m "feat: expandable split detail rows on activities page"
```

---

### Task 5: Expandable split detail on the plan page

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `GET /api/activities/:stravaId/splits`, `GET /api/activities/:stravaId/feedback`, plan status API (already loaded)
- Produces: click-to-expand day cells showing split table + optional narrative below the week row

- [ ] **Step 1: Add CSS for the plan detail panel**

In the `<style>` block of `index.html`, add before the closing `</style>`:

```css
  .day.clickable { cursor: pointer; }
  .day.clickable:hover { background: var(--blue-light); }
  .day.clickable.expanded { background: var(--blue-light); }

  .plan-detail {
    grid-column: 1 / -1;
    background: var(--card); border: 1px solid var(--card-border); border-radius: 0 0 6px 6px;
    padding: 16px 24px; margin-bottom: 8px;
  }
  .plan-split-table { width: 100%; max-width: 500px; border-collapse: collapse; font-size: 12px; margin-bottom: 12px; }
  .plan-split-table th {
    text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--ink-muted); font-weight: 500; padding: 4px 8px; border-bottom: 1px solid var(--grid);
  }
  .plan-split-table th.num { text-align: right; }
  .plan-split-table td { padding: 6px 8px; border-bottom: 1px solid var(--grid); font-variant-numeric: tabular-nums; }
  .plan-split-table td.num { text-align: right; }
  .plan-split-table tr:last-child td { border-bottom: none; }
  .plan-narrative {
    background: var(--surface); border: 1px solid var(--card-border); border-radius: 6px;
    padding: 16px; font-size: 13px; line-height: 1.6; color: var(--ink-secondary);
    white-space: pre-wrap; max-width: 700px;
  }
  .plan-narrative strong { color: var(--ink-primary); }
```

- [ ] **Step 2: Store the strava_id mapping in plan status**

The plan status API returns `actual.name` and `actual.distance` but not the strava_id. We need the strava_id to fetch splits. Modify `src/plan.ts` to include it.

In `src/plan.ts`, update the `PlanDayStatus` interface's `actual` to include `strava_id`:

```typescript
  actual?: {
    strava_id?: number;
    distance?: number;
    moving_time?: number;
    average_speed?: number;
    average_heartrate?: number;
    name?: string;
    type?: string;
    weather?: { temp: number; feels: number; humidity: number; wind: number; code: number } | null;
  };
```

In the `getPlanStatus` function, where `actual` objects are built for runs (around the `return { date, dayOfWeek, ... actual: { ... } }` blocks), add `strava_id: bestRun.strava_id` to the run actual object and `strava_id: liftAct.strava_id` to the lift actual (though we only use it for runs).

The `getActivities` query in `plan.ts` already selects from the activities table. Ensure `strava_id` is included in the selected columns (it already is, it's part of the query).

Add `strava_id` to the run actual:

```typescript
      return {
        date, dayOfWeek: di, plan: planInfo, status,
        actual: {
          strava_id: bestRun.strava_id,
          distance: totalDistance, moving_time: bestRun.moving_time,
          average_speed: bestRun.average_speed, average_heartrate: bestRun.average_heartrate,
          name: bestRun.name, type: bestRun.type, weather: weatherOf(bestRun),
        },
      };
```

And for lifts:

```typescript
          return {
            date, dayOfWeek: di, plan: planInfo, status: "completed" as const,
            actual: { strava_id: liftAct.strava_id, moving_time: liftAct.moving_time, average_heartrate: liftAct.average_heartrate, name: liftAct.name, type: liftAct.type, weather: weatherOf(liftAct) },
          };
```

- [ ] **Step 3: Add helper functions and expand/collapse logic to index.html**

In the `<script>` block, add after the `weekStartDate` function and before `renderPlan`:

```javascript
function splitPace(speedMs) {
  if (!speedMs) return '--';
  const paceMin = 1609.34 / speedMs / 60;
  const m = Math.floor(paceMin);
  const s = Math.round((paceMin - m) * 60);
  return m + ':' + String(s).padStart(2, '0') + '/mi';
}

function elevFt(meters) {
  if (meters == null) return '--';
  const ft = meters * 3.281;
  return (ft >= 0 ? '+' : '') + Math.round(ft) + ' ft';
}

function renderPlanSplitTable(splits) {
  let html = '<table class="plan-split-table"><thead><tr>';
  html += '<th>Mile</th><th class="num">Pace</th><th class="num">HR</th><th class="num">Elev</th><th class="num">Zone</th>';
  html += '</tr></thead><tbody>';
  for (const s of splits) {
    html += '<tr>';
    html += '<td>' + (s.split_index + 1) + '</td>';
    html += '<td class="num">' + splitPace(s.average_speed) + '</td>';
    html += '<td class="num">' + (s.average_heartrate ? Math.round(s.average_heartrate) : '--') + '</td>';
    html += '<td class="num">' + elevFt(s.elevation_diff) + '</td>';
    html += '<td class="num">' + (s.pace_zone || '--') + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

let expandedPlanDetail = null;

async function togglePlanDetail(dayEl, stravaId) {
  const existing = document.getElementById('plan-detail-panel');
  if (existing) {
    const wasThisDay = existing.dataset.stravaId === String(stravaId);
    existing.remove();
    if (expandedPlanDetail) expandedPlanDetail.classList.remove('expanded');
    expandedPlanDetail = null;
    if (wasThisDay) return;
  }

  dayEl.classList.add('expanded');
  expandedPlanDetail = dayEl;

  const weekRow = dayEl.closest('.week-row');
  const panel = document.createElement('div');
  panel.id = 'plan-detail-panel';
  panel.dataset.stravaId = stravaId;
  panel.className = 'plan-detail';
  panel.innerHTML = '<p style="color:var(--ink-muted);font-size:12px;">Loading splits...</p>';
  weekRow.after(panel);

  try {
    let html = '';
    const splitsRes = await fetch('/api/activities/' + stravaId + '/splits');
    if (splitsRes.ok) {
      const data = await splitsRes.json();
      html += renderPlanSplitTable(data.splits);
    } else {
      html += '<p style="color:var(--ink-muted);font-size:12px;">No split data available.</p>';
    }

    const fbRes = await fetch('/api/activities/' + stravaId + '/feedback');
    if (fbRes.ok) {
      const fb = await fbRes.json();
      html += '<div class="plan-narrative">' + fb.narrative.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') + '</div>';
    }

    panel.innerHTML = html;
  } catch (e) {
    panel.innerHTML = '<p style="color:var(--accent);">Failed to load details.</p>';
  }
}
```

- [ ] **Step 4: Make completed run days clickable in `renderWeekRow`**

In the `renderWeekRow` function, where the day cell is built for completed/partial runs, add clickability. After the line that builds the day's `cls` string and before the `html += '<div class="' + cls + '">'` line, add the strava_id data attribute and clickable class:

```javascript
    let extraAttr = '';
    if (sd && sd.actual && sd.actual.strava_id && sd.actual.type === 'Run') {
      cls += ' clickable';
      extraAttr = ' data-strava-id="' + sd.actual.strava_id + '"';
    }

    html += '<div class="' + cls + '"' + extraAttr + '>';
```

Then in `renderPlan`, after `root.innerHTML = html;` and before the chart initialization, add click handlers:

```javascript
  root.querySelectorAll('.day.clickable').forEach(dayEl => {
    dayEl.addEventListener('click', () => {
      togglePlanDetail(dayEl, dayEl.dataset.stravaId);
    });
  });
```

- [ ] **Step 5: Test in browser**

Open `https://training.localhost/`. Click a completed run day (one with a checkmark). Verify:
- A detail panel appears below the week row with the split table
- Clicking the same day collapses it
- Clicking a different day swaps the panel
- Non-run days and upcoming days are not clickable

- [ ] **Step 6: Commit**

```bash
git add public/index.html src/plan.ts
git commit -m "feat: expandable split detail on plan page with strava_id passthrough"
```

---

### Task 6: Create the `mattstack:run-feedback` skill

**Files:**
- Create: `~/Documents/GitHub/mattstack/skills/infra/run-feedback/SKILL.md`

**Interfaces:**
- Consumes: `POST https://training.localhost/api/sync`, `GET https://training.localhost/api/plan/status`, `GET https://training.localhost/api/activities`, `GET https://training.localhost/api/activities/:id/splits`, `POST https://training.localhost/api/activities/:id/feedback`
- Produces: LLM-generated narrative and structured analysis stored via the feedback API

- [ ] **Step 1: Write the skill SKILL.md**

Create `~/Documents/GitHub/mattstack/skills/infra/run-feedback/SKILL.md`:

```markdown
---
name: mattstack:run-feedback
description: "Analyze a run against the training plan and generate data-dense feedback with per-mile split breakdown, effort classification, and trend context. Use when the user says 'give me feedback on my run', 'analyze my run', 'run feedback', 'how was my run', or '/run-feedback'. Optionally accepts a date argument (e.g., '/run-feedback July 6')."
---

# Run Feedback

Generate data-dense, numbers-first analysis of a run against the training plan prescription. Not hand-wavy commentary -- use all the data: pace, HR, elevation, weather, and historical baselines.

## Steps

1. **Sync latest data**

```bash
curl -s -X POST "https://training.localhost/api/sync" | python3 -m json.tool
```

2. **Identify the target run**

If the user specified a date, use it. Otherwise, find the most recent run:

```bash
curl -s "https://training.localhost/api/activities?type=Run&limit=5"
```

Pick the run matching the requested date, or the most recent. Note its `strava_id`, `start_date_local`, `distance`, `moving_time`, `average_speed`, `average_heartrate`, `max_heartrate`, `total_elevation_gain`, and weather fields.

3. **Fetch splits**

```bash
curl -s "https://training.localhost/api/activities/{strava_id}/splits"
```

This returns per-mile splits with: `split_index`, `distance`, `elapsed_time`, `moving_time`, `elevation_diff` (meters), `average_speed` (m/s), `average_heartrate`, `pace_zone`.

4. **Get plan prescription for that date**

```bash
curl -s "https://training.localhost/api/plan/status"
```

Find the day matching the run's date. Extract: `plan.type`, `plan.miles`, `plan.label`, `plan.detail`. Map the detail to an effort type using the plan's glossary (e.g., "easy" = 9:30-10:00/mi, "tempo" = race pace ~8:30/mi).

5. **Compute baselines from recent history**

```bash
curl -s "https://training.localhost/api/activities?type=Run&limit=20"
```

From the last 20 runs, compute:
- **Easy HR baseline**: average of avg_heartrate from recent runs where distance was 3-4mi and average_speed was in easy range (2.5-2.9 m/s, i.e., ~9:15-10:45/mi)
- **Pace-at-HR trend**: for runs at similar HR, how has pace changed over time?
- **Recent elevation context**: typical elevation gain for this runner's routes

6. **Generate analysis**

Build `analysis_json` (structured data) and `narrative` (markdown text). The narrative MUST follow this structure:

**Header line**: distance (mi), time, avg pace, avg HR, max HR, weather feels-like temp

**Per-mile breakdown** (one line per split):
- Mile N -- pace, HR, elevation gain/loss in feet, and what the numbers mean in context of this specific run. Reference the plan prescription. Note inflection points (where pace jumped, where HR spiked, where elevation explains or doesn't explain the data).

**Effort summary**:
- What was prescribed vs what was run (use the glossary pace ranges)
- Avg HR vs personal easy baseline (compute the delta, state it as a number)
- Heat-adjusted effort: if feels-like >= 80°F, note that heat adds roughly 5-8 bpm to equivalent cool-weather HR. Classify the heat-adjusted effort.

**Elevation analysis**:
- Total gain in feet
- Distribution across miles (which mile had the most climb)
- Whether elevation explains the pace/HR pattern or if effort was independently high

**Trend context**:
- How this run's HR compares to recent runs at the same prescription
- Any fitness signals (pace improving at same HR, or HR dropping for same pace)
- Heat acclimatization signal if applicable

**Recovery implication**:
- What's the next planned workout?
- Does this run's effort level change how that workout should be approached?

All numbers must use actual data, not approximations. Cite the specific values from the splits, weather, and baseline computations.

7. **Post the feedback**

```bash
curl -s -X POST "https://training.localhost/api/activities/{strava_id}/feedback" \
  -H "Content-Type: application/json" \
  -d '{
    "plan_date": "YYYY-MM-DD",
    "plan_id": "10k-oct-2026",
    "prescribed_type": "easy",
    "prescribed_miles": 3,
    "analysis_json": "{...}",
    "narrative": "..."
  }'
```

8. **Confirm to the user**

Print a brief summary of the key finding (e.g., "Feedback saved for your July 9 run. Key takeaway: ran 34s/mi faster than prescribed easy pace, HR 5 bpm above your baseline."). The full narrative is on the plan page now.
```

- [ ] **Step 2: Symlink the skill**

```bash
ln -sf ~/Documents/GitHub/mattstack/skills/infra/run-feedback ~/.claude/skills/mattstack:run-feedback
```

- [ ] **Step 3: Update mattstack README**

Add to the infra section:

```markdown
- **mattstack:run-feedback** -- analyze a run against the training plan with per-mile split breakdown, effort classification, and trend context. Generates data-dense feedback stored in the training app.
```

- [ ] **Step 4: Update `~/.claude/CLAUDE.md` skills list**

Add `mattstack:run-feedback` to the skills enumeration.

- [ ] **Step 5: Commit (in mattstack repo)**

```bash
cd ~/Documents/GitHub/mattstack
git add skills/infra/run-feedback/SKILL.md README.md
git commit -m "feat: add mattstack:run-feedback skill for training plan run analysis"
```

---

### Task 7: End-to-end test

**Files:** none (testing only)

- [ ] **Step 1: Restart the training app server**

```bash
launchctl unload ~/Library/LaunchAgents/com.matthewgoodwin.training-plan.plist
launchctl load ~/Library/LaunchAgents/com.matthewgoodwin.training-plan.plist
```

Wait 2 seconds, then verify:
```bash
curl -sf "https://training.localhost/" -o /dev/null && echo "OK"
```

- [ ] **Step 2: Trigger sync to populate splits**

```bash
curl -s -X POST "https://training.localhost/api/sync" | python3 -m json.tool
```

Verify splits populated:
```bash
sqlite3 /Users/matt/Documents/GitHub/training-plan/data/training.db \
  "SELECT a.name, a.start_date_local, COUNT(s.id) as split_count FROM activities a JOIN activity_splits s ON a.strava_id = s.activity_strava_id GROUP BY a.strava_id ORDER BY a.start_date_local DESC LIMIT 10"
```

- [ ] **Step 3: Test the activities page expand/collapse**

Open `https://training.localhost/activities.html` in the browser. Click a run row. Verify:
- Split table appears with Mile, Pace, HR, Elev, Zone columns
- Data looks reasonable (paces in the 8-11 min/mi range, HR in 130-170 range)
- Clicking another run collapses the first
- Edit button and Strava links still work

- [ ] **Step 4: Test the plan page expand/collapse**

Open `https://training.localhost/`. Click a completed run day in the grid. Verify:
- Detail panel appears below the week row with splits
- Panel collapses on re-click

- [ ] **Step 5: Invoke the skill to generate feedback**

Use the `mattstack:run-feedback` skill to generate feedback for today's run. After it runs, verify:
- Feedback appears in the DB
- Refreshing the activities page and expanding the run shows the narrative card below the splits
- The plan page also shows the narrative when expanding that day

- [ ] **Step 6: Final commit with any fixes**

If any adjustments were needed during testing, commit them.

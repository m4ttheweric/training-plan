# Run Feedback: Design Spec

**Date**: 2026-07-09
**Status**: Draft

## Overview

A two-layer run analysis system: (1) automatic collection of per-mile split data during Strava sync, and (2) on-demand LLM-generated narrative feedback via a Claude Code skill. Both layers feed into the existing plan and activity pages.

## Layer 1: Data Collection (automatic during sync)

### New Strava detail fetch

After upserting a run activity from the list endpoint, fetch `GET /activities/{strava_id}` (the detail endpoint, resource_state=3) to get `splits_standard[]`. Only fetch for:

- Activities where `type = 'Run'`
- Activities that don't already have splits stored (idempotent)

The detail endpoint also backfills fields the summary lacks: `calories`, `suffer_score`, `description` (update the parent activity row if these are null).

### `activity_splits` table

```sql
CREATE TABLE activity_splits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_strava_id INTEGER NOT NULL REFERENCES activities(strava_id),
    split_index INTEGER NOT NULL,
    distance REAL NOT NULL,           -- meters (~1609 per mile)
    elapsed_time INTEGER NOT NULL,    -- seconds
    moving_time INTEGER NOT NULL,     -- seconds
    elevation_diff REAL,              -- meters, signed (+/-)
    average_speed REAL,               -- m/s
    average_heartrate REAL,           -- bpm (nullable, no HR monitor)
    pace_zone INTEGER,                -- Strava's zone classification (1-5)
    UNIQUE(activity_strava_id, split_index)
);
CREATE INDEX idx_splits_activity ON activity_splits(activity_strava_id);
```

Source: `splits_standard[]` from Strava detail endpoint. These are mile-based splits (not km).

### Sync flow change

In `sync.ts`, after the existing upsert loop:

1. Collect strava_ids of runs that were just upserted
2. For each, check if `activity_splits` already has rows for that strava_id
3. If not, call `stravaGet('/activities/' + stravaId)` to fetch the detail record
4. Insert `splits_standard[]` into `activity_splits`
5. Update parent activity's `calories`, `suffer_score`, `description` if null

Rate limit consideration: one extra API call per new run. With 3-5 runs/week and syncing daily, this is 3-5 extra calls per sync. Strava's limit is 100 req/15 min and 1000/day -- not a concern at this volume.

## Layer 2: LLM Analysis (on-demand via skill)

### `run_feedback` table

```sql
CREATE TABLE run_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_strava_id INTEGER NOT NULL UNIQUE REFERENCES activities(strava_id),
    plan_date TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    prescribed_type TEXT NOT NULL,     -- "easy", "long", "tempo", etc.
    prescribed_miles REAL,
    analysis_json TEXT NOT NULL,        -- structured analysis (JSON)
    narrative TEXT NOT NULL,            -- full LLM-written analysis (markdown)
    created_at TEXT DEFAULT (datetime('now'))
);
```

### `analysis_json` structure

```json
{
  "effort_vs_plan": "moderate",
  "avg_pace": "8:56/mi",
  "target_pace": "9:30-10:00/mi",
  "avg_hr": 150.6,
  "max_hr": 171,
  "baseline_easy_hr": 145.8,
  "total_elevation_m": 38.9,
  "weather_impact": "moderate",
  "heat_adjusted_effort": "tempo",
  "splits": [
    {
      "mile": 1,
      "pace": "9:42/mi",
      "hr": 142,
      "elevation_m": -3.2,
      "note": "controlled start"
    }
  ],
  "recovery_flag": true,
  "recovery_note": "Ran moderate-to-tempo on a prescribed easy day in heat. Consider extra restraint on tomorrow's long run."
}
```

### Narrative format

Data-dense, numbers-first analysis. Not hand-wavy commentary. Structure:

1. **Header line**: distance, time, avg pace, avg HR, weather
2. **Per-mile breakdown**: pace, HR, elevation (meters), what the numbers mean in context
3. **Effort summary**: prescribed vs actual effort classification, HR vs personal easy baseline, heat-adjusted effort rating
4. **Elevation analysis**: total gain, distribution across miles, impact on pace/HR
5. **Trend context**: how this run compares to recent runs at the same prescription (rolling HR baseline, pace-at-HR fitness signal, heat acclimatization)
6. **Recovery implication**: what this means for the next planned workout

### Baseline computation

The skill queries recent activities to establish personal baselines:

- **Easy HR baseline**: rolling average of avg HR from the last 4-6 runs where the plan prescribed "easy" and the runner was compliant (within 80% of target pace range)
- **Pace-at-HR**: trend of pace achieved at a given HR over the plan period (fitness proxy)
- **Heat acclimatization**: same-temperature HR comparison across weeks

### The skill: `mattstack:run-feedback`

Lives at `~/.claude/skills/mattstack:run-feedback/SKILL.md`. Invocation triggers:

- "give me feedback on today's run"
- "run feedback for July 6"
- "analyze my run"
- "/run-feedback"

Skill flow:

1. Trigger a Strava sync (ensures latest data + splits are fetched)
2. Identify the target run: most recent run, or a specific date if provided as arg
3. Read splits from `GET /api/activities/:stravaId/splits`
4. Read plan prescription for that date from `GET /api/plan/status`
5. Read recent run history from `GET /api/activities?type=Run&limit=20` for baseline computation
6. Generate `analysis_json` and `narrative`
7. POST to `POST /api/activities/:stravaId/feedback`
8. Confirm to the user what was written

## Layer 3: Display

### API endpoints

**`GET /api/activities/:stravaId/splits`**

Returns `{ splits: SplitRow[] }` or 404 if no splits exist.

**`GET /api/activities/:stravaId/feedback`**

Returns `{ analysis_json, narrative, plan_date, prescribed_type, prescribed_miles, created_at }` or 404 if no feedback exists.

**`POST /api/activities/:stravaId/feedback`**

Body: `{ analysis_json, narrative, plan_date, plan_id, prescribed_type, prescribed_miles }`

Upserts into `run_feedback` table. Returns `{ ok: true }`.

### Plan page (index.html)

Completed run days in the plan grid become clickable. Clicking a completed day expands a detail row below the week grid showing:

- **Split table**: Mile | Pace | HR | Elev | Zone -- always shown if splits exist
- **Narrative card**: the LLM-written feedback -- shown if feedback exists, hidden if not

The expand/collapse is per-day. Only one day expanded at a time (clicking another collapses the first). Data is fetched on demand when expanded (not loaded upfront for all days).

The existing weather badge, status icon, and actual distance display remain unchanged.

### Activities page (activities.html)

Run rows in the activities table become expandable. Clicking a run row expands a detail section below showing the same split table + narrative card. Same behavior as the plan page: one row expanded at a time.

### No-feedback state

If a day has splits but no LLM feedback, the split table renders alone -- still valuable as raw data. No placeholder text like "Run /run-feedback to generate analysis" -- the data speaks for itself.

## What doesn't change

- Plan JSON files (the plan is the prescription, not the feedback)
- Existing weather data flow
- Existing plan status API response shape (splits/feedback are fetched separately on demand)
- Lift/rest day rendering

## Rate limits and performance

- Detail fetch adds 1 API call per new run during sync (3-5/week)
- Split and feedback data fetched on demand per click, not bulk-loaded
- SQLite is fine for this volume -- single user, handful of runs per week

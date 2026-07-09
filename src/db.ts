import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "../data/training.db");
const db = new Database(DB_PATH, { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL DEFAULT 0,
    athlete_id INTEGER,
    athlete_json TEXT
  );

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strava_id INTEGER UNIQUE NOT NULL,
    name TEXT,
    type TEXT,
    sport_type TEXT,
    distance REAL,
    moving_time INTEGER,
    elapsed_time INTEGER,
    start_date TEXT,
    start_date_local TEXT,
    timezone TEXT,
    average_speed REAL,
    max_speed REAL,
    average_heartrate REAL,
    max_heartrate REAL,
    total_elevation_gain REAL,
    elev_high REAL,
    elev_low REAL,
    suffer_score REAL,
    calories REAL,
    average_cadence REAL,
    description TEXT,
    workout_type INTEGER,
    map_summary_polyline TEXT,
    raw_json TEXT,
    synced_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_activities_start ON activities(start_date_local);
  CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);
`);

for (const col of [
  "start_lat REAL", "start_lng REAL",
  "weather_temp REAL", "weather_feels REAL",
  "weather_humidity INTEGER", "weather_wind REAL", "weather_code INTEGER",
]) {
  try { db.exec(`ALTER TABLE activities ADD COLUMN ${col}`); } catch {}
}

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

export function getTokens() {
  return db.query("SELECT * FROM tokens WHERE id = 1").get() as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    athlete_id: number | null;
    athlete_json: string | null;
  } | null;
}

export function saveTokens(accessToken: string, refreshToken: string, expiresAt: number, athleteId?: number, athleteJson?: string) {
  db.query(`
    INSERT INTO tokens (id, access_token, refresh_token, expires_at, athlete_id, athlete_json)
    VALUES (1, ?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(id) DO UPDATE SET
      access_token = ?1, refresh_token = ?2, expires_at = ?3,
      athlete_id = COALESCE(?4, athlete_id),
      athlete_json = COALESCE(?5, athlete_json)
  `).run(accessToken, refreshToken, expiresAt, athleteId ?? null, athleteJson ?? null);
}

export function upsertActivity(a: Record<string, unknown>) {
  db.query(`
    INSERT INTO activities (
      strava_id, name, type, sport_type, distance, moving_time, elapsed_time,
      start_date, start_date_local, timezone, average_speed, max_speed,
      average_heartrate, max_heartrate, total_elevation_gain, elev_high, elev_low,
      suffer_score, calories, average_cadence, description, workout_type,
      map_summary_polyline, raw_json, start_lat, start_lng
    ) VALUES (
      $strava_id, $name, $type, $sport_type, $distance, $moving_time, $elapsed_time,
      $start_date, $start_date_local, $timezone, $average_speed, $max_speed,
      $average_heartrate, $max_heartrate, $total_elevation_gain, $elev_high, $elev_low,
      $suffer_score, $calories, $average_cadence, $description, $workout_type,
      $map_summary_polyline, $raw_json, $start_lat, $start_lng
    )
    ON CONFLICT(strava_id) DO UPDATE SET
      name = $name, type = $type, sport_type = $sport_type, distance = $distance,
      moving_time = $moving_time, elapsed_time = $elapsed_time,
      average_speed = $average_speed, max_speed = $max_speed,
      average_heartrate = $average_heartrate, max_heartrate = $max_heartrate,
      total_elevation_gain = $total_elevation_gain, suffer_score = $suffer_score,
      calories = $calories, average_cadence = $average_cadence,
      start_lat = $start_lat, start_lng = $start_lng,
      raw_json = $raw_json, synced_at = datetime('now')
  `).run({
    $strava_id: a.id,
    $name: a.name ?? null,
    $type: a.type ?? null,
    $sport_type: a.sport_type ?? null,
    $distance: a.distance ?? null,
    $moving_time: a.moving_time ?? null,
    $elapsed_time: a.elapsed_time ?? null,
    $start_date: a.start_date ?? null,
    $start_date_local: a.start_date_local ?? null,
    $timezone: a.timezone ?? null,
    $average_speed: a.average_speed ?? null,
    $max_speed: a.max_speed ?? null,
    $average_heartrate: a.average_heartrate ?? null,
    $max_heartrate: a.max_heartrate ?? null,
    $total_elevation_gain: a.total_elevation_gain ?? null,
    $elev_high: a.elev_high ?? null,
    $elev_low: a.elev_low ?? null,
    $suffer_score: a.suffer_score ?? null,
    $calories: a.calories ?? null,
    $average_cadence: a.average_cadence ?? null,
    $description: a.description ?? null,
    $workout_type: a.workout_type ?? null,
    $map_summary_polyline: (a.map as Record<string, unknown>)?.summary_polyline ?? null,
    $raw_json: JSON.stringify(a),
    $start_lat: (a.start_latlng as number[])?.[0] ?? null,
    $start_lng: (a.start_latlng as number[])?.[1] ?? null,
  });
}

export function getActivities(opts: { type?: string; after?: string; before?: string; limit?: number; offset?: number } = {}) {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts.type) { conditions.push("type = $type"); params.$type = opts.type; }
  if (opts.after) { conditions.push("start_date_local >= $after"); params.$after = opts.after; }
  if (opts.before) { conditions.push("start_date_local <= $before"); params.$before = opts.before; }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;

  return db.query(`
    SELECT strava_id, name, type, sport_type, distance, moving_time, elapsed_time,
           start_date_local, average_speed, max_speed, average_heartrate, max_heartrate,
           total_elevation_gain, suffer_score, calories, average_cadence, workout_type,
           weather_temp, weather_feels, weather_humidity, weather_wind, weather_code
    FROM activities ${where}
    ORDER BY start_date_local DESC
    LIMIT $limit OFFSET $offset
  `).all({ ...params, $limit: limit, $offset: offset });
}

export function getWeeklyStats(opts: { after?: string; type?: string } = {}) {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.after) { conditions.push("start_date_local >= $after"); params.$after = opts.after; }
  if (opts.type) { conditions.push("type = $type"); params.$type = opts.type; }
  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  return db.query(`
    SELECT
      strftime('%Y-W%W', start_date_local) as week,
      MIN(date(start_date_local)) as week_start,
      COUNT(*) as count,
      SUM(distance) as total_distance,
      SUM(moving_time) as total_time,
      AVG(average_speed) as avg_speed,
      AVG(average_heartrate) as avg_hr,
      MAX(distance) as longest_run,
      SUM(total_elevation_gain) as total_elevation
    FROM activities ${where}
    GROUP BY week
    ORDER BY week DESC
  `).all(params);
}

export function getActivitiesMissingWeather() {
  return db.query(`
    SELECT strava_id, start_date_local, timezone, start_lat, start_lng
    FROM activities
    WHERE start_lat IS NOT NULL AND start_lng IS NOT NULL AND weather_temp IS NULL
    ORDER BY start_date_local DESC
  `).all() as Array<{ strava_id: number; start_date_local: string; timezone: string; start_lat: number; start_lng: number }>;
}

export function updateActivityWeather(stravaId: number, weather: { temp: number; feels: number; humidity: number; wind: number; code: number }) {
  db.query(`
    UPDATE activities SET weather_temp = $temp, weather_feels = $feels,
    weather_humidity = $humidity, weather_wind = $wind, weather_code = $code
    WHERE strava_id = $id
  `).run({ $temp: weather.temp, $feels: weather.feels, $humidity: weather.humidity, $wind: weather.wind, $code: weather.code, $id: stravaId });
}

export function updateActivityName(stravaId: number, name: string) {
  db.query("UPDATE activities SET name = $name, synced_at = datetime('now') WHERE strava_id = $id").run({ $name: name, $id: stravaId });
}

export function getActivityCount() {
  return (db.query("SELECT COUNT(*) as count FROM activities").get() as { count: number }).count;
}

export function getLastSyncedDate() {
  const row = db.query("SELECT MAX(start_date_local) as latest FROM activities").get() as { latest: string | null };
  return row?.latest ?? null;
}

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

export function updateActivityDetail(stravaId: number, detail: { calories?: number; suffer_score?: number; description?: string }): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { $id: stravaId };
  if (detail.calories != null) { sets.push("calories = COALESCE(calories, $cal)"); params.$cal = detail.calories; }
  if (detail.suffer_score != null) { sets.push("suffer_score = COALESCE(suffer_score, $ss)"); params.$ss = detail.suffer_score; }
  if (detail.description != null) { sets.push("description = COALESCE(description, $desc)"); params.$desc = detail.description; }
  if (!sets.length) return;
  db.query(`UPDATE activities SET ${sets.join(", ")} WHERE strava_id = $id`).run(params);
}

export default db;

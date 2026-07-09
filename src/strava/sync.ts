import { stravaGet } from "./client";
import { upsertActivity, getLastSyncedDate, getActivityCount, insertSplits, getRunsMissingSplits, updateActivityDetail } from "../db";
import { backfillWeather } from "../weather";

interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  start_date: string;
  start_date_local: string;
  timezone: string;
  average_speed: number;
  max_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  total_elevation_gain: number;
  elev_high?: number;
  elev_low?: number;
  suffer_score?: number;
  calories?: number;
  average_cadence?: number;
  description?: string;
  workout_type?: number;
  start_latlng?: number[];
  map?: { summary_polyline?: string };
}

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

export async function syncActivities(opts: { full?: boolean } = {}) {
  const PER_PAGE = 200;
  let page = 1;
  let fetched = 0;
  let upserted = 0;

  const params: Record<string, string | number> = { per_page: PER_PAGE };

  if (!opts.full) {
    const windowDays = 120;
    const after = Math.floor(Date.now() / 1000) - windowDays * 86400;
    params.after = after;
    console.log(`Incremental sync: activities from last ${windowDays} days`);
  } else {
    console.log("Full sync: fetching all activities");
  }

  while (true) {
    const activities = await stravaGet<StravaActivity[]>("/athlete/activities", { ...params, page });

    if (!activities.length) break;

    for (const a of activities) {
      upsertActivity(a as unknown as Record<string, unknown>);
      upserted++;
    }

    fetched += activities.length;
    console.log(`  page ${page}: ${activities.length} activities (${fetched} total)`);

    if (activities.length < PER_PAGE) break;
    page++;
  }

  await backfillWeather();
  await backfillSplits();

  const total = getActivityCount();
  return { fetched, upserted, total };
}

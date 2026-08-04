import { getActivitiesMissingWeather, updateActivityWeather } from "./db";
// Shared with the browser on purpose: "how old is this activity" needs to
// agree with the same wall-clock "today" the rest of the app uses.
import { localDate } from "../public/lib.js";

const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";

/* Open-Meteo splits "recent" and "historical" weather across two endpoints
   that accept the identical query string and return the identical `hourly`
   shape. The forecast endpoint only serves a rolling window (roughly the
   last three months through a couple weeks out); an activity older than
   that gets a 400 "start_date out of allowed range" error that never heals
   itself, since the window keeps sliding forward and the activity only
   falls further outside it. The archive endpoint covers arbitrary history
   but typically lags a few days behind real time, so the most recent
   activities are not in it yet.

   7 days is comfortably past that archive lag while still deep inside the
   forecast window, so it decides which endpoint to TRY FIRST: activities
   newer than this try forecast first, older ones try archive first.
   fetchWeatherForActivity() falls back to the other endpoint if the first
   choice fails, so a wrong guess right at the boundary still succeeds
   instead of failing outright. */
const ARCHIVE_CUTOFF_DAYS = 7;

function daysAgo(dateIso: string, todayIso: string): number {
  return Math.round((Date.parse(todayIso) - Date.parse(dateIso)) / 86400000);
}

/* Pure so the endpoint choice can be unit tested without network access. */
export function pickWeatherEndpoint(activityDate: string, today: string): string {
  return daysAgo(activityDate, today) > ARCHIVE_CUTOFF_DAYS ? OPEN_METEO_ARCHIVE : OPEN_METEO_FORECAST;
}

function extractTimezone(tz: string): string {
  const match = tz.match(/\) (.+)$/);
  return match ? match[1] : "America/Chicago";
}

interface HourlyResponse {
  hourly: {
    time: string[];
    temperature_2m: number[];
    apparent_temperature: number[];
    relative_humidity_2m: number[];
    wind_speed_10m: number[];
    weather_code: number[];
  };
}

async function fetchFromEndpoint(
  base: string,
  act: { start_lat: number; start_lng: number },
  date: string,
  tz: string
): Promise<HourlyResponse> {
  const params = new URLSearchParams({
    latitude: act.start_lat.toFixed(3),
    longitude: act.start_lng.toFixed(3),
    hourly: "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    start_date: date,
    end_date: date,
    timezone: tz,
  });

  const res = await fetch(`${base}?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo error ${res.status}`);
  return res.json() as Promise<HourlyResponse>;
}

async function fetchWeatherForActivity(act: { start_date_local: string; start_lat: number; start_lng: number; timezone: string }) {
  const date = act.start_date_local.slice(0, 10);
  const hour = parseInt(act.start_date_local.slice(11, 13)) || 12;
  const tz = extractTimezone(act.timezone);

  const primary = pickWeatherEndpoint(date, localDate());
  const secondary = primary === OPEN_METEO_ARCHIVE ? OPEN_METEO_FORECAST : OPEN_METEO_ARCHIVE;

  let data: HourlyResponse;
  try {
    data = await fetchFromEndpoint(primary, act, date, tz);
  } catch {
    // Neither endpoint alone covers every date: the archive lags real time
    // by a few days and the forecast window doesn't reach far into the
    // past, so a wrong guess near the boundary retries once against the
    // other endpoint before giving up.
    data = await fetchFromEndpoint(secondary, act, date, tz);
  }

  const idx = Math.min(hour, data.hourly.time.length - 1);
  return {
    temp: data.hourly.temperature_2m[idx],
    feels: data.hourly.apparent_temperature[idx],
    humidity: data.hourly.relative_humidity_2m[idx],
    wind: data.hourly.wind_speed_10m[idx],
    code: data.hourly.weather_code[idx],
  };
}

export async function backfillWeather() {
  const missing = getActivitiesMissingWeather();
  if (!missing.length) return { updated: 0 };

  let updated = 0;
  for (const act of missing) {
    try {
      const weather = await fetchWeatherForActivity(act);
      updateActivityWeather(act.strava_id, weather);
      updated++;
    } catch (e) {
      console.error(`Weather fetch failed for activity ${act.strava_id}:`, e);
    }
  }

  console.log(`Weather backfilled for ${updated}/${missing.length} activities`);
  return { updated, total: missing.length };
}

import { getActivitiesMissingWeather, updateActivityWeather } from "./db";

const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";

const IANA_TIMEZONES: Record<string, string> = {};

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

async function fetchWeatherForActivity(act: { start_date_local: string; start_lat: number; start_lng: number; timezone: string }) {
  const date = act.start_date_local.slice(0, 10);
  const hour = parseInt(act.start_date_local.slice(11, 13)) || 12;
  const tz = extractTimezone(act.timezone);

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

  const res = await fetch(`${OPEN_METEO}?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo error ${res.status}`);
  const data = await res.json() as HourlyResponse;

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

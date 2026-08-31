export interface DailyMetric {
  date: string;
  metric: string;
  value: number;
  units: string | null;
}

/* Health Auto Export stamps every sample "YYYY-MM-DD HH:MM:SS ±HHMM" in the
   phone's local zone. Reading the wall clock literally, rather than through
   Date, keeps a night's sleep attached to the day the watch assigned it: a
   23:01 bedtime parsed as UTC would slide across the date line and land on the
   wrong night. */
const STAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

interface Stamp { day: number; hours: number }

function parseStamp(raw: unknown): Stamp | null {
  if (typeof raw !== "string") return null;
  const m = STAMP.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return {
    day: Date.UTC(Number(y), Number(mo) - 1, Number(d)) / 86_400_000,
    hours: Number(h) + Number(mi) / 60 + Number(s) / 3600,
  };
}

function parseDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = STAMP.exec(raw);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function num(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/* Hours between a timestamp and midnight opening `date`. Negative means the
   event happened the evening before, which is the normal case for a bedtime
   and is what makes this directly comparable across nights. */
function offsetHours(stamp: unknown, date: string): number | null {
  const at = parseStamp(stamp);
  const base = parseStamp(`${date} 00:00:00`);
  if (!at || !base) return null;
  return (at.day - base.day) * 24 + at.hours;
}

const SLEEP_STAGES: Record<string, string> = {
  totalSleep: "sleep_total",
  asleep: "sleep_asleep",
  core: "sleep_core",
  rem: "sleep_rem",
  deep: "sleep_deep",
  awake: "sleep_awake",
  inBed: "sleep_in_bed",
};

const HEART_RATE_SERIES: Record<string, string> = {
  Avg: "heart_rate_avg",
  Max: "heart_rate_max",
  Min: "heart_rate_min",
};

function expand(name: string, entry: Record<string, unknown>, date: string): Array<[string, number]> {
  if (name === "sleep_analysis") {
    const out: Array<[string, number]> = [];
    for (const [field, metric] of Object.entries(SLEEP_STAGES)) {
      const v = num(entry[field]);
      if (v !== null) out.push([metric, v]);
    }
    const start = offsetHours(entry.sleepStart, date);
    const end = offsetHours(entry.sleepEnd, date);
    if (start !== null) out.push(["sleep_start_offset", start]);
    if (end !== null) out.push(["sleep_end_offset", end]);
    return out;
  }

  if (name === "heart_rate") {
    const out: Array<[string, number]> = [];
    for (const [field, metric] of Object.entries(HEART_RATE_SERIES)) {
      const v = num(entry[field]);
      if (v !== null) out.push([metric, v]);
    }
    return out;
  }

  const v = num(entry.qty);
  return v === null ? [] : [[name, v]];
}

export function parseHealthExport(raw: unknown): DailyMetric[] {
  const metrics = (raw as { data?: { metrics?: unknown } })?.data?.metrics;
  if (!Array.isArray(metrics)) return [];

  const rows: DailyMetric[] = [];
  for (const metric of metrics) {
    const name = (metric as { name?: unknown })?.name;
    const samples = (metric as { data?: unknown })?.data;
    if (typeof name !== "string" || !name || !Array.isArray(samples)) continue;

    const units = typeof (metric as { units?: unknown }).units === "string"
      ? (metric as { units: string }).units
      : null;

    for (const sample of samples) {
      if (!sample || typeof sample !== "object") continue;
      const date = parseDate((sample as { date?: unknown }).date);
      if (!date) continue;
      for (const [key, value] of expand(name, sample as Record<string, unknown>, date)) {
        rows.push({ date, metric: key, value, units });
      }
    }
  }
  return rows;
}

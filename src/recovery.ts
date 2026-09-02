import { getPlanStatus, type PlanStatusResponse } from "./plan";
import { getDailyMetrics } from "./db";
import { localDate } from "../public/lib.js";

/* A night longer than this is the old double-counted export shape, not a real
   sleep. Same guard the run-feedback readiness query uses. */
const MAX_PLAUSIBLE_SLEEP = 12;

/* Bar scaling and the adequacy bands the Plan page colours against. Endurance
   builds want 7.5-9h; 7 is the line below which recovery starts costing, 6 the
   line below which it costs a lot. */
export const SLEEP_TARGET = 8;
export const SLEEP_ADEQUATE = 7;

export interface RecoveryWeek {
  week: number;
  weekStart: string;
  recovery: boolean;
  current: boolean;
  miles: number;
  runs: number;
  avgSleep: number | null;
  avgDeep: number | null;
  nights: number;
}

export interface RecoveryResponse {
  target: number;
  adequate: number;
  planAvgSleep: number | null;
  weeksWithSleep: number;
  weeksAtTarget: number;
  weeks: RecoveryWeek[];
}

interface SleepRow { date: string; metric: string; value: number }

function addDays(date: string, n: number): string {
  const d = new Date(date + "T12:00:00");
  d.setDate(d.getDate() + n);
  return localDate(d);
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

const RUN_SLOTS = new Set(["run", "long", "race"]);

/* Pure so the bucketing, the >12h guard and the coverage counts are testable
   without a database, mirroring buildToday. getRecovery below supplies the
   real plan status and sleep rows. */
export function buildRecovery(
  status: PlanStatusResponse,
  sleepRows: SleepRow[],
  asOf?: string,
): RecoveryResponse {
  const now = asOf ?? localDate();
  const empty: RecoveryResponse = {
    target: SLEEP_TARGET, adequate: SLEEP_ADEQUATE,
    planAvgSleep: null, weeksWithSleep: 0, weeksAtTarget: 0, weeks: [],
  };

  // Only weeks that have actually started. A scorecard of empty future weeks is
  // noise, and their sleep rows do not exist yet anyway.
  const started = status.weeks.filter((w) => w.weekStart <= now);
  if (!started.length) return empty;

  // date -> { total, deep }, keyed the way the watch filed the night (the
  // morning it ended), so a night lands in the week its morning belongs to.
  const byNight = new Map<string, { total?: number; deep?: number }>();
  for (const row of sleepRows) {
    const night = byNight.get(row.date) ?? {};
    if (row.metric === "sleep_total") night.total = row.value;
    else if (row.metric === "sleep_deep") night.deep = row.value;
    byNight.set(row.date, night);
  }

  const allNightTotals: number[] = [];

  const weeks: RecoveryWeek[] = started.map((w) => {
    const totals: number[] = [];
    const deeps: number[] = [];
    for (let i = 0; i < 7; i++) {
      const night = byNight.get(addDays(w.weekStart, i));
      // A counted night needs a plausible total; deep only rides along when the
      // night itself counts, so a stray deep sample cannot invent a night.
      if (night?.total == null || night.total > MAX_PLAUSIBLE_SLEEP) continue;
      totals.push(night.total);
      if (night.deep != null) deeps.push(night.deep);
    }
    allNightTotals.push(...totals);

    let runs = 0;
    for (const d of w.days) {
      if (d.actual && RUN_SLOTS.has(d.plan.type)) runs++;
      runs += d.extra?.length ?? 0;
    }

    return {
      week: w.week,
      weekStart: w.weekStart,
      recovery: w.recovery,
      current: w.weekStart <= now && addDays(w.weekStart, 6) >= now,
      miles: w.summary.actualMiles,
      runs,
      avgSleep: mean(totals),
      avgDeep: mean(deeps),
      nights: totals.length,
    };
  });

  // A week with neither a run nor a scored night is nothing to show yet. This
  // drops the just-started current week that has no data until its first run or
  // night lands, rather than trailing the card with an all-dashes row.
  const shown = weeks.filter((w) => w.nights > 0 || w.miles > 0);

  return {
    target: SLEEP_TARGET,
    adequate: SLEEP_ADEQUATE,
    planAvgSleep: mean(allNightTotals),
    weeksWithSleep: shown.filter((w) => w.nights > 0).length,
    weeksAtTarget: shown.filter((w) => w.avgSleep != null && w.avgSleep >= SLEEP_ADEQUATE).length,
    weeks: shown,
  };
}

export function getRecovery(planId?: string, asOf?: string): RecoveryResponse {
  const now = asOf ?? localDate();
  const status = getPlanStatus(planId, now);

  const started = status.weeks.filter((w) => w.weekStart <= now);
  if (!started.length) return buildRecovery(status, [], now);

  const windowStart = started[0].weekStart;
  const windowEnd = addDays(started[started.length - 1].weekStart, 6);
  const sleepRows = getDailyMetrics({
    after: windowStart, before: windowEnd, metrics: ["sleep_total", "sleep_deep"],
  });

  return buildRecovery(status, sleepRows, now);
}

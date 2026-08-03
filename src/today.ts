import { getPlanStatus } from "./plan";
import { getSplitsForActivity, getFeedbackForActivity } from "./db";

export interface TodayLookup {
  splits(stravaId: number): unknown[];
  feedback(stravaId: number): { narrative: string; analysis_json: string } | null;
}

const DAY_MS = 86400000;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / DAY_MS);
}

export function buildToday(status: any, todayIso: string, lookup: TodayLookup) {
  const week = status.weeks.find((w: any) => w.days.some((d: any) => d.date === todayIso)) ?? null;
  const day = week ? week.days.find((d: any) => d.date === todayIso) : null;

  // A rest day has no prescription to state.
  const plan = day && day.plan.type !== "rest" ? {
    type: day.plan.type, miles: day.plan.miles, label: day.plan.label, detail: day.plan.detail,
  } : null;

  const phaseName = week
    ? (status.plan.phases.find((p: any) => p.id === week.phase)?.name ?? week.phase)
    : null;

  // Flatten once; both "next session" and "last run" are ordered scans over it.
  const allDays = status.weeks.flatMap((w: any) => w.days);

  const nextDay = allDays.find((d: any) =>
    d.date > todayIso && d.plan.type !== "rest");
  const next = nextDay ? { date: nextDay.date, label: nextDay.plan.label } : null;

  const runDays = allDays
    .filter((d: any) => d.actual && d.actual.type === "Run" && (d.actual.date ?? d.date) <= todayIso)
    .sort((a: any, b: any) => (b.actual.date ?? b.date).localeCompare(a.actual.date ?? a.date));

  let lastRun = null;
  if (runDays.length) {
    const d = runDays[0];
    const a = d.actual;
    const fb = lookup.feedback(a.strava_id);
    lastRun = {
      strava_id: a.strava_id,
      name: a.name,
      date: a.date ?? d.date,
      slotDate: d.date,
      shiftedFrom: a.date && a.date !== d.date ? d.date : null,
      prescribed: { type: d.plan.type, miles: d.plan.miles, detail: d.plan.detail },
      distance: a.distance,
      moving_time: a.moving_time,
      average_speed: a.average_speed,
      average_heartrate: a.average_heartrate,
      weather: a.weather ?? null,
      splits: lookup.splits(a.strava_id),
      narrative: fb ? fb.narrative : null,
      analysis: fb ? safeParse(fb.analysis_json) : null,
    };
  }

  const weeks = status.weeks
    .filter((w: any) => w.weekStart <= todayIso)
    .slice(-3)
    .map((w: any) => ({
      number: w.week,
      recovery: w.recovery,
      current: week ? w.week === week.week : false,
      actualMiles: w.summary.actualMiles,
      plannedMiles: w.summary.plannedMiles,
      completedRuns: w.summary.completedRuns,
      plannedRuns: w.summary.plannedRuns,
    }));

  const race = status.plan.race ? {
    ...status.plan.race,
    daysAway: daysBetween(status.plan.race.date, todayIso),
  } : null;

  return {
    date: todayIso,
    plan,
    week: week ? {
      number: week.week, phase: week.phase, phaseName,
      recovery: week.recovery,
      phaseDescription: status.plan.phases.find((p: any) => p.id === week.phase)?.description ?? null,
    } : null,
    race,
    next,
    lastRun,
    weeks,
  };
}

function safeParse(s: string) {
  try { return JSON.parse(s); } catch { return null; }
}

export function getToday(todayIso?: string) {
  const now = todayIso ?? new Date().toISOString().slice(0, 10);
  return buildToday(getPlanStatus(undefined, now), now, {
    splits: (id) => getSplitsForActivity(id),
    feedback: (id) => getFeedbackForActivity(id),
  });
}

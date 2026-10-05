import { getPlanStatus } from "./plan";
import { getSplitsForActivity, getFeedbackForActivity } from "./db";
// Shared with the browser on purpose: client and server must agree on "today".
import { localDate } from "../public/lib.js";

export interface TodayLookup {
  splits(stravaId: number): unknown[];
  feedback(stravaId: number): { narrative: string; analysis_json: string } | null;
}

const DAY_MS = 86400000;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / DAY_MS);
}

// Glossary entries are written for the generic case ("6-8 x 30-sec"); when a
// specific day pins down its rep count, swap that range for the real number
// so today's prescription doesn't read like a menu of options.
// A bare long run names only its distance, so its pace target would go
// unstated; the workout type doubles as a glossary term for those days.
const TYPE_TERM: Record<string, string> = { long: "long", run: "easy" };

// A day's detail can stack multiple glossary terms ("+ strides + Bench") or
// use an alternate phrasing ("w/ strides", "Dead lt · race-AM rehearsal").
// Split on the "+"/"·" joiners and the "w/ " prefix so each piece can match
// its own glossary entry independently, then show every match found.
function detailText(glossary: Array<{ term: string; definition: string }> | undefined, detail?: string, reps?: number): string | null {
  if (!glossary || !detail) return null;
  const aliases = glossary.flatMap(entry =>
    entry.term.split(" / ").map(alias => ({ core: alias.replace(/^\+ /, "").trim(), entry })));

  // A trailing "lt" (as in "+ Dead lt") is the same light-weight modifier the
  // "light" entry defines on its own -- strip it and pull "light" in too,
  // rather than matching the unrelated "Dead / Dead lt" lift-day entry.
  const segments = detail.split(/[+·]/).map(s => s.replace(/^w\/\s*/, "").trim()).filter(Boolean);
  const found = segments.flatMap(segment => {
    const isLight = / lt$/.test(segment);
    const core = isLight ? segment.replace(/ lt$/, "") : segment;
    const entry = aliases.find(a => a.core === core)?.entry;
    const lightEntry = isLight ? glossary.find(g => g.term === "light") : undefined;
    return [entry, lightEntry].filter((e): e is { term: string; definition: string } => !!e);
  });
  const matches = found.filter((entry, i, arr) => arr.indexOf(entry) === i);

  if (!matches.length) return null;
  const texts = matches.map(entry =>
    reps != null ? entry.definition.replace(/\d+-\d+(?= x )/, String(reps)) : entry.definition);
  return texts.join(" ");
}

export function buildToday(status: any, todayIso: string, lookup: TodayLookup) {
  const week = status.weeks.find((w: any) => w.days.some((d: any) => d.date === todayIso)) ?? null;
  const day = week ? week.days.find((d: any) => d.date === todayIso) : null;

  // A rest day has no prescription to state.
  const detail = day ? day.plan.detail ?? TYPE_TERM[day.plan.type] : undefined;
  const plan = day && day.plan.type !== "rest" ? {
    type: day.plan.type, miles: day.plan.miles, label: day.plan.label, detail,
    detailText: detailText(status.plan.glossary, detail, day.plan.reps),
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
      max_heartrate: a.max_heartrate,
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

  const firstDate = allDays[0]?.date;
  const lastDate = allDays.at(-1)?.date;
  const planState = firstDate && todayIso < firstDate ? "upcoming"
    : lastDate && todayIso > lastDate ? "complete" : "active";

  return {
    date: todayIso,
    planState,
    planStartDate: firstDate ?? null,
    planEndDate: lastDate ?? null,
    afterPlan: planState === "complete" ? status.plan.afterPlan ?? null : null,
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
  const now = todayIso ?? localDate();
  return buildToday(getPlanStatus(undefined, now), now, {
    splits: (id) => getSplitsForActivity(id),
    feedback: (id) => getFeedbackForActivity(id),
  });
}

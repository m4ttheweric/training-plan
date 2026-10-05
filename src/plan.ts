import { join } from "path";
import { readdirSync, readFileSync } from "fs";
import { getActivities } from "./db";
// Shared with the browser on purpose: client and server must agree on "today".
import { localDate } from "../public/lib.js";

const PLANS_DIR = join(import.meta.dir, "../plans");

import { PLAN_ID_PATTERN, chooseDefaultPlan, validatePlan, type PlanDay, type PlanFile } from "./plan-schema";

interface ActualInfo {
  strava_id?: number;
  distance?: number;
  moving_time?: number;
  average_speed?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  name?: string;
  type?: string;
  date?: string;
  weather?: { temp: number; feels: number; humidity: number; wind: number; code: number } | null;
}

interface PlanDayStatus {
  date: string;
  dayOfWeek: number;
  plan: { type: string; miles?: number; label: string; detail?: string; reps?: number; newSlot?: boolean };
  status: "completed" | "partial" | "missed" | "upcoming" | "today" | "rest";
  actual?: ActualInfo;
  /** Set when the activity filling this slot happened on a different date. */
  shiftedFrom?: string;
  /** Activities on this calendar date that no plan slot claimed. */
  extra?: ActualInfo[];
}

interface PlanWeekStatus {
  week: number;
  weekStart: string;
  phase: string;
  recovery: boolean;
  days: PlanDayStatus[];
  summary: { plannedRuns: number; completedRuns: number; plannedMiles: number; actualMiles: number };
}

export interface PlanStatusResponse {
  plan: PlanFile;
  weeks: PlanWeekStatus[];
}

function listPlans(): string[] {
  return readdirSync(PLANS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => f.replace(/\.json$/, ""))
    .sort();
}

export function loadPlan(planId?: string): PlanFile {
  const id = planId ?? (process.env.PLAN_ID?.trim() || chooseDefaultPlan(listPlans().map(id => loadPlan(id)), localDate()).id);
  if (!id) throw new Error("No plans found in " + PLANS_DIR);
  if (!PLAN_ID_PATTERN.test(id)) throw new Error("Invalid plan ID");
  const path = join(PLANS_DIR, id + ".json");
  return validatePlan(JSON.parse(readFileSync(path, "utf-8")), id);
}

export function getAvailablePlans(): Array<{ id: string; name: string; startDate: string }> {
  return listPlans().map(id => {
    const plan = loadPlan(id);
    return { id: plan.id, name: plan.name, startDate: plan.startDate };
  });
}

function dateStr(weekStart: string, dayOffset: number): string {
  const d = new Date(weekStart + "T12:00:00");
  d.setDate(d.getDate() + dayOffset);
  return localDate(d);
}

function weekStartDate(planStart: string, weekIndex: number): string {
  const d = new Date(planStart + "T12:00:00");
  d.setDate(d.getDate() + weekIndex * 7);
  return localDate(d);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 86400000);
}

function dayLabel(day: PlanDay): string {
  if (day.type === "rest") return "rest";
  if (day.type === "race") return day.label ?? "Race";
  if (day.type === "lift") return day.label ?? "Lift";
  if (day.miles) return `${day.miles} mi`;
  return day.label ?? "";
}

function phaseForWeek(plan: PlanFile, weekNum: number): string {
  for (const p of plan.phases) {
    if (p.weeks.includes(weekNum)) return p.id;
  }
  return "unknown";
}

export function getPlanStatus(planId?: string, today?: string): PlanStatusResponse {
  const plan = loadPlan(planId);
  const now = today ?? localDate();

  const weekStarts = plan.weeks.map((_, i) => weekStartDate(plan.startDate, i));

  const allDates = weekStarts.flatMap((ws, wi) =>
    plan.weeks[wi].days.map((_, di) => dateStr(ws, di))
  );
  const earliest = allDates[0];
  const latest = allDates[allDates.length - 1];

  const activities = getActivities({ after: earliest, before: latest + "T23:59:59", limit: 5000 }) as Array<{
    strava_id: number;
    start_date_local: string;
    type: string;
    distance: number;
    moving_time: number;
    average_speed: number;
    average_heartrate: number;
    max_heartrate: number;
    name: string;
    weather_temp: number | null;
    weather_feels: number | null;
    weather_humidity: number | null;
    weather_wind: number | null;
    weather_code: number | null;
  }>;

  function weatherOf(a: typeof activities[number]) {
    if (a.weather_temp == null) return null;
    return { temp: a.weather_temp, feels: a.weather_feels!, humidity: a.weather_humidity!, wind: a.weather_wind!, code: a.weather_code! };
  }

  type Activity = typeof activities[number];

  function actualOf(a: Activity): ActualInfo {
    return {
      strava_id: a.strava_id, distance: a.distance, moving_time: a.moving_time,
      average_speed: a.average_speed, average_heartrate: a.average_heartrate,
      max_heartrate: a.max_heartrate,
      name: a.name, type: a.type, date: a.start_date_local.slice(0, 10),
      weather: weatherOf(a),
    };
  }

  function shiftedFrom(a: Activity, slotDate: string): { shiftedFrom?: string } {
    const actualDate = a.start_date_local.slice(0, 10);
    return actualDate === slotDate ? {} : { shiftedFrom: actualDate };
  }

  const actByDate = new Map<string, Activity[]>();
  for (const a of activities) {
    const d = a.start_date_local.slice(0, 10);
    if (!actByDate.has(d)) actByDate.set(d, []);
    actByDate.get(d)!.push(a);
  }

  // --- Slot assignment ---------------------------------------------------
  // Workouts move. A Friday long run done Saturday morning is still the
  // Friday long run, so match on intent (nearest slot that wants this kind
  // of activity) rather than strictly on calendar date.

  const SHIFT_WINDOW_DAYS = 1;

  function slotWants(day: PlanDay, activityType: string): boolean {
    if (day.type === "lift") return activityType === "WeightTraining";
    if (day.type === "run" || day.type === "long" || day.type === "race") return activityType === "Run";
    return false;
  }

  const slots = weekStarts.flatMap((ws, wi) =>
    plan.weeks[wi].days.map((day, di) => ({ key: `${wi}:${di}`, date: dateStr(ws, di), day }))
  );

  const assigned = new Map<string, Activity[]>();
  const claimed = new Set<number>();

  // Pass 1: exact date. Same-day always wins over any shifted candidate.
  for (const slot of slots) {
    const acts = (actByDate.get(slot.date) ?? []).filter(a => slotWants(slot.day, a.type));
    if (!acts.length) continue;
    assigned.set(slot.key, acts);
    for (const a of acts) claimed.add(a.strava_id);
  }

  // Pass 2: pull leftovers into an adjacent empty slot that wants them.
  // Prefer the nearest slot, and on a tie prefer the earlier one, since a
  // workout is far more often a makeup than done ahead of schedule.
  for (const a of activities) {
    if (claimed.has(a.strava_id)) continue;
    const aDate = a.start_date_local.slice(0, 10);
    let best: typeof slots[number] | null = null;
    let bestScore = Infinity;
    for (const slot of slots) {
      if (assigned.has(slot.key)) continue;
      if (slot.date > now) continue;
      if (!slotWants(slot.day, a.type)) continue;
      const diff = daysBetween(slot.date, aDate);
      if (diff === 0 || Math.abs(diff) > SHIFT_WINDOW_DAYS) continue;
      const score = Math.abs(diff) * 10 + (diff < 0 ? 0 : 1);
      if (score < bestScore) { bestScore = score; best = slot; }
    }
    if (best) {
      assigned.set(best.key, [a]);
      claimed.add(a.strava_id);
    }
  }

  // Anything still unclaimed is real work that no slot wanted. It stays
  // visible on its own date and its mileage still counts toward the week.
  const unclaimedByDate = new Map<string, Activity[]>();
  for (const a of activities) {
    if (claimed.has(a.strava_id) || a.type !== "Run") continue;
    const d = a.start_date_local.slice(0, 10);
    if (!unclaimedByDate.has(d)) unclaimedByDate.set(d, []);
    unclaimedByDate.get(d)!.push(a);
  }

  const weeks: PlanWeekStatus[] = plan.weeks.map((pw, wi) => {
    const ws = weekStarts[wi];
    let plannedRuns = 0, completedRuns = 0, plannedMiles = 0, actualMiles = 0;

    const days: PlanDayStatus[] = pw.days.map((day, di) => {
      const date = dateStr(ws, di);
      const slotActs = assigned.get(`${wi}:${di}`) ?? [];
      const label = dayLabel(day);

      // Runs no slot claimed still count as miles run, whatever day they landed on.
      const strays = unclaimedByDate.get(date) ?? [];
      const strayDistance = strays.reduce((s, a) => s + (a.distance ?? 0), 0);
      if (strayDistance > 0) actualMiles += strayDistance / 1609.34;
      const extra = strays.length ? { extra: strays.map(actualOf) } : {};

      if (day.type === "rest") {
        return { date, dayOfWeek: di, plan: { type: day.type, label, detail: day.detail, newSlot: day.newSlot }, status: "rest" as const, ...extra };
      }

      const planInfo = { type: day.type, miles: day.miles, label, detail: day.detail, reps: day.reps, newSlot: day.newSlot };

      if (date > now) {
        if (day.miles) { plannedRuns++; plannedMiles += day.miles; }
        return { date, dayOfWeek: di, plan: planInfo, status: "upcoming" as const, ...extra };
      }

      // A slot only counts as missed once its day is actually over.
      const unmetStatus = date === now ? "today" as const : "missed" as const;

      if (day.type === "lift") {
        const liftAct = slotActs.find(a => a.type === "WeightTraining");
        if (!liftAct) {
          return { date, dayOfWeek: di, plan: planInfo, status: unmetStatus, ...extra };
        }
        const shifted = shiftedFrom(liftAct, date);
        return {
          date, dayOfWeek: di, plan: planInfo, status: "completed" as const,
          actual: actualOf(liftAct), ...shifted, ...extra,
        };
      }

      if (day.miles) { plannedRuns++; plannedMiles += day.miles; }
      const targetMeters = (day.miles ?? 0) * 1609.34;
      const runActs = slotActs.filter(a => a.type === "Run");

      if (!runActs.length) {
        return { date, dayOfWeek: di, plan: planInfo, status: unmetStatus, ...extra };
      }

      const totalDistance = runActs.reduce((s, a) => s + (a.distance ?? 0), 0);
      const bestRun = runActs.reduce((best, a) => (a.distance > best.distance ? a : best), runActs[0]);
      actualMiles += totalDistance / 1609.34;

      const ratio = targetMeters > 0 ? totalDistance / targetMeters : 1;
      const status = ratio >= 0.8 ? "completed" as const : "partial" as const;
      if (status === "completed") completedRuns++;

      return {
        date, dayOfWeek: di, plan: planInfo, status,
        actual: { ...actualOf(bestRun), distance: totalDistance },
        ...shiftedFrom(bestRun, date), ...extra,
      };
    });

    return {
      week: pw.week,
      weekStart: ws,
      phase: phaseForWeek(plan, pw.week),
      recovery: !!pw.recovery,
      days,
      summary: { plannedRuns, completedRuns, plannedMiles, actualMiles },
    };
  });

  return { plan, weeks };
}

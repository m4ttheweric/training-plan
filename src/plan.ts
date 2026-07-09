import { join } from "path";
import { readdirSync, readFileSync } from "fs";
import { getActivities } from "./db";

const PLANS_DIR = join(import.meta.dir, "../plans");

interface PlanDay {
  type: "run" | "long" | "lift" | "rest" | "race";
  miles?: number;
  label?: string;
  detail?: string;
  newSlot?: boolean;
}

interface PlanWeek {
  week: number;
  recovery?: boolean;
  days: PlanDay[];
}

interface PlanFile {
  id: string;
  name: string;
  subtitle: string;
  startDate: string;
  race?: { name: string; date: string; distance: number; targetPace: string; targetTime: string };
  phases: Array<{ id: string; name: string; tag: string; type?: string; description: string; weeks: number[] }>;
  afterPlan?: { name: string; tag: string; description: string };
  weeks: PlanWeek[];
  glossary: Array<{ term: string; definition: string }>;
  rules: Array<{ label: string; text: string }>;
  callout: string;
}

interface PlanDayStatus {
  date: string;
  dayOfWeek: number;
  plan: { type: string; miles?: number; label: string; detail?: string; newSlot?: boolean };
  status: "completed" | "partial" | "missed" | "upcoming" | "rest";
  actual?: {
    strava_id?: number;
    distance?: number;
    moving_time?: number;
    average_speed?: number;
    average_heartrate?: number;
    name?: string;
    type?: string;
    weather?: { temp: number; feels: number; humidity: number; wind: number; code: number } | null;
  };
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
  const id = planId ?? listPlans()[0];
  if (!id) throw new Error("No plans found in " + PLANS_DIR);
  const path = join(PLANS_DIR, id + ".json");
  return JSON.parse(readFileSync(path, "utf-8"));
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
  return d.toISOString().slice(0, 10);
}

function weekStartDate(planStart: string, weekIndex: number): string {
  const d = new Date(planStart + "T12:00:00");
  d.setDate(d.getDate() + weekIndex * 7);
  return d.toISOString().slice(0, 10);
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
  const now = today ?? new Date().toISOString().slice(0, 10);

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

  const actByDate = new Map<string, typeof activities>();
  for (const a of activities) {
    const d = a.start_date_local.slice(0, 10);
    if (!actByDate.has(d)) actByDate.set(d, []);
    actByDate.get(d)!.push(a);
  }

  const weeks: PlanWeekStatus[] = plan.weeks.map((pw, wi) => {
    const ws = weekStarts[wi];
    let plannedRuns = 0, completedRuns = 0, plannedMiles = 0, actualMiles = 0;

    const days: PlanDayStatus[] = pw.days.map((day, di) => {
      const date = dateStr(ws, di);
      const dayActs = actByDate.get(date) ?? [];
      const label = dayLabel(day);

      if (day.type === "rest") {
        return { date, dayOfWeek: di, plan: { type: day.type, label, detail: day.detail, newSlot: day.newSlot }, status: "rest" as const };
      }

      const planInfo = { type: day.type, miles: day.miles, label, detail: day.detail, newSlot: day.newSlot };

      if (date > now) {
        if (day.miles) { plannedRuns++; plannedMiles += day.miles; }
        return { date, dayOfWeek: di, plan: planInfo, status: "upcoming" as const };
      }

      if (day.type === "lift") {
        const liftAct = dayActs.find(a => a.type === "WeightTraining");
        if (liftAct) {
          return {
            date, dayOfWeek: di, plan: planInfo, status: "completed" as const,
            actual: { strava_id: liftAct.strava_id, moving_time: liftAct.moving_time, average_heartrate: liftAct.average_heartrate, name: liftAct.name, type: liftAct.type, weather: weatherOf(liftAct) },
          };
        }
        return { date, dayOfWeek: di, plan: planInfo, status: "missed" as const };
      }

      if (day.miles) { plannedRuns++; plannedMiles += day.miles; }
      const targetMeters = (day.miles ?? 0) * 1609.34;
      const runActs = dayActs.filter(a => a.type === "Run");

      if (!runActs.length) {
        return { date, dayOfWeek: di, plan: planInfo, status: "missed" as const };
      }

      const totalDistance = runActs.reduce((s, a) => s + (a.distance ?? 0), 0);
      const bestRun = runActs.reduce((best, a) => (a.distance > best.distance ? a : best), runActs[0]);
      actualMiles += totalDistance / 1609.34;

      const ratio = targetMeters > 0 ? totalDistance / targetMeters : 1;
      const status = ratio >= 0.8 ? "completed" as const : "partial" as const;
      if (status === "completed") completedRuns++;

      return {
        date, dayOfWeek: di, plan: planInfo, status,
        actual: {
          strava_id: bestRun.strava_id,
          distance: totalDistance, moving_time: bestRun.moving_time,
          average_speed: bestRun.average_speed, average_heartrate: bestRun.average_heartrate,
          name: bestRun.name, type: bestRun.type, weather: weatherOf(bestRun),
        },
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

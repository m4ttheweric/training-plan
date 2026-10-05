import Ajv from "ajv";
import addFormats from "ajv-formats";
import schema from "../schemas/training-plan.schema.json";

export interface PlanDay {
  type: "run" | "long" | "lift" | "rest" | "race";
  miles?: number;
  label?: string;
  detail?: string;
  reps?: number;
  newSlot?: boolean;
}

export interface PlanFile {
  $schema?: string;
  id: string;
  name: string;
  subtitle: string;
  startDate: string;
  race?: { name: string; date: string; distance: number; targetPace: string; targetTime: string };
  phases: Array<{ id: string; name: string; tag: string; type?: string; description: string; weeks: number[] }>;
  afterPlan?: { name: string; tag: string; description: string };
  weeks: Array<{ week: number; recovery?: boolean; days: PlanDay[] }>;
  glossary: Array<{ term: string; definition: string }>;
  rules: Array<{ label: string; text: string }>;
  callout: string;
}

export const PLAN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ajv = new Ajv({ allErrors: true, strictRequired: false });
addFormats(ajv);
const checkShape = ajv.compile<PlanFile>(schema);

/** The schema checks shape; these checks enforce relationships across fields. */
export function validatePlan(data: unknown, expectedId?: string): PlanFile {
  if (!checkShape(data)) {
    throw new Error("Invalid training plan: " + ajv.errorsText(checkShape.errors, { separator: "; " }));
  }
  const errors: string[] = [];
  if (expectedId !== undefined && data.id !== expectedId) errors.push(`id must match filename: ${expectedId}.json`);
  const start = new Date(data.startDate + "T12:00:00Z");
  if (start.getUTCDay() !== 1) errors.push("startDate must be a Monday; days are ordered Monday through Sunday");
  data.weeks.forEach((week, i) => {
    if (week.week !== i + 1) errors.push(`weeks[${i}].week must be ${i + 1}`);
  });
  const phaseIds = new Set<string>();
  const covered = new Set<number>();
  for (const phase of data.phases) {
    if (phaseIds.has(phase.id)) errors.push(`duplicate phase id: ${phase.id}`);
    phaseIds.add(phase.id);
    for (const week of phase.weeks) {
      if (week > data.weeks.length) errors.push(`phase ${phase.id} references nonexistent week ${week}`);
      if (covered.has(week)) errors.push(`week ${week} belongs to more than one phase`);
      covered.add(week);
    }
  }
  for (let week = 1; week <= data.weeks.length; week++) {
    if (!covered.has(week)) errors.push(`week ${week} needs a phase`);
  }
  const raceDates: string[] = [];
  data.weeks.forEach((week, wi) => week.days.forEach((day, di) => {
    if (day.type !== "race") return;
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + wi * 7 + di);
    raceDates.push(date.toISOString().slice(0, 10));
    if (data.race && Math.abs(day.miles! - data.race.distance) > 0.05) errors.push("race day miles must match race.distance");
  }));
  if (data.race && (raceDates.length !== 1 || raceDates[0] !== data.race.date)) {
    errors.push("race.date must match the single race day in the weekly schedule");
  }
  if (!data.race && raceDates.length) errors.push("race days need race metadata");
  if (errors.length) throw new Error("Invalid training plan: " + errors.join("; "));
  return data;
}

/** Prefer the latest started plan, otherwise the earliest upcoming plan. */
export function chooseDefaultPlan(plans: PlanFile[], today: string): PlanFile {
  if (!plans.length) throw new Error("No plans found");
  const sorted = [...plans].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
  const active = sorted.filter(plan => {
    const end = new Date(plan.startDate + "T12:00:00Z");
    end.setUTCDate(end.getUTCDate() + plan.weeks.length * 7 - 1);
    return plan.startDate <= today && today <= end.toISOString().slice(0, 10);
  });
  return active.at(-1) ?? sorted.filter(plan => plan.startDate <= today).at(-1) ?? sorted[0];
}

import { getPlanStatus } from "./plan";
// Shared with the browser on purpose: client and server must agree on "today".
import { localDate } from "../public/lib.js";

/* One flat, newest-first stream opening on the newest real entry. Upcoming days
   are deliberately left out: the plan page is where you look ahead, and putting
   them above today buried the thing you actually came to see. Week summaries
   are emitted as rules between days rather than as a separate view. */
export function buildJournal(status: any, todayIso: string) {
  const items: any[] = [];

  // Walk weeks newest first so the rule for a week lands after its days.
  const weeks = [...status.weeks].sort((a: any, b: any) => b.weekStart.localeCompare(a.weekStart));

  for (const w of weeks) {
    const dayItems: any[] = [];

    for (const d of w.days) {
      if (d.plan.type === "rest") continue;

      const a = d.actual;
      if (a && a.type === "Run") {
        dayItems.push({
          kind: d.plan.type === "long" ? "long" : "run",
          date: a.date ?? d.date,
          slotDate: d.date,
          shiftedFrom: d.shiftedFrom ? d.date : null,
          prescribed: { type: d.plan.type, miles: d.plan.miles, label: d.plan.label, detail: d.plan.detail },
          activity: a,
        });
      } else if (a) {
        dayItems.push({ kind: "lift", date: a.date ?? d.date, label: d.plan.label, activity: a });
      } else if (d.status === "today") {
        dayItems.push({ kind: "today", date: d.date, label: d.plan.label, detail: d.plan.detail });
      } else if (d.status === "upcoming") {
        continue;
      } else if (d.status === "missed" || d.status === "partial") {
        dayItems.push({ kind: "missed", date: d.date, label: d.plan.label, planType: d.plan.type });
      }
    }

    dayItems.sort((x, y) => y.date.localeCompare(x.date));
    items.push(...dayItems);

    // Only summarise a week that has actually produced something. A week whose
    // only entry is today has nothing to summarise yet, so the newest rule in
    // the stream belongs to the last week with real results.
    const hasResults = dayItems.some(i => i.kind !== "today");
    if (w.weekStart <= todayIso && hasResults) {
      items.push({
        kind: "week-rule",
        week: w.week,
        recovery: w.recovery,
        actualMiles: w.summary.actualMiles,
        plannedMiles: w.summary.plannedMiles,
        completedRuns: w.summary.completedRuns,
        plannedRuns: w.summary.plannedRuns,
      });
    }
  }

  return items;
}

export function getJournal(todayIso?: string) {
  const now = todayIso ?? localDate();
  return buildJournal(getPlanStatus(undefined, now), now);
}

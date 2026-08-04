import { expect, test, describe } from "bun:test";
import { buildJournal } from "../src/journal";

const status: any = {
  plan: { id: "10k-oct-2026", name: "10K Race Plan", phases: [], race: null },
  weeks: [
    {
      // Oldest week. A single real result, on its own, checks that a
      // week-rule still fires for a week with just one non-future item
      // (the some()/every() distinction can't be told apart on one item
      // alone -- week 4 below is what proves that), and gives the
      // ordering tests a second week-rule to order against.
      week: 3, weekStart: "2026-07-20", phase: "base", recovery: false,
      summary: { plannedRuns: 2, completedRuns: 2, plannedMiles: 6, actualMiles: 6.2 },
      days: [
        { date: "2026-07-22", dayOfWeek: 2, plan: { type: "lift", label: "Row" }, status: "completed",
          actual: { strava_id: 5, moving_time: 1800, name: "row erg", type: "WeightTraining", date: "2026-07-22" } },
      ],
    },
    {
      week: 4, weekStart: "2026-07-27", phase: "recovery-1", recovery: true,
      summary: { plannedRuns: 3, completedRuns: 3, plannedMiles: 9, actualMiles: 9.667 },
      days: [
        // Synthetic: dated in the past on purpose. Proves the week-rule
        // filter must use `.some`, not `.every` -- a week with one
        // future/today item mixed among real results must still get a
        // rule. (Every other day below in this week is a real result, so
        // `.every` over the whole set would wrongly come out false and
        // swallow week 4's rule.)
        { date: "2026-07-28", dayOfWeek: 1, plan: { type: "run", miles: 2, label: "2 mi", detail: "shakeout" }, status: "upcoming" },
        { date: "2026-07-29", dayOfWeek: 2, plan: { type: "lift", label: "Bench" }, status: "completed",
          actual: { strava_id: 2, moving_time: 2384, name: "bench", type: "WeightTraining", date: "2026-07-29" } },
        // A plain, unshifted run -- proves "run" plan type maps to kind
        // "run", not "long" (the fixture otherwise only ever produces a
        // "long" item, which can't tell the ternary's two branches apart).
        { date: "2026-07-30", dayOfWeek: 3, plan: { type: "run", miles: 2, label: "2 mi", detail: "easy" }, status: "completed",
          actual: { strava_id: 4, distance: 3218.7, moving_time: 1200, average_speed: 2.68,
                    average_heartrate: 138, name: "Morning shakeout", type: "Run", date: "2026-07-30", weather: null } },
        { date: "2026-07-31", dayOfWeek: 4, plan: { type: "long", miles: 3.5, label: "3.5 mi", detail: "easy" },
          status: "completed", shiftedFrom: "2026-08-01",
          actual: { strava_id: 1, distance: 6524.4, moving_time: 2326, average_speed: 2.805,
                    average_heartrate: 143.1, name: "Half Moon Bay", type: "Run", date: "2026-08-01", weather: null } },
        { date: "2026-08-01", dayOfWeek: 5, plan: { type: "lift", label: "Dead" }, status: "missed" },
        { date: "2026-08-02", dayOfWeek: 6, plan: { type: "rest", label: "rest" }, status: "rest" },
      ],
    },
    {
      week: 5, weekStart: "2026-08-03", phase: "build", recovery: false,
      summary: { plannedRuns: 4, completedRuns: 0, plannedMiles: 14, actualMiles: 0 },
      days: [
        { date: "2026-08-03", dayOfWeek: 0, plan: { type: "run", miles: 3, label: "3 mi", detail: "+ strides" }, status: "today" },
        { date: "2026-08-04", dayOfWeek: 1, plan: { type: "lift", label: "Squat" }, status: "upcoming" },
        { date: "2026-08-09", dayOfWeek: 6, plan: { type: "rest", label: "rest" }, status: "rest" },
      ],
    },
  ],
};

describe("buildJournal", () => {
  const items = buildJournal(status, "2026-08-03");
  const kinds = items.map((i: any) => i.kind);

  test("is ordered newest first, future above today", () => {
    expect(kinds.indexOf("future")).toBeLessThan(kinds.indexOf("today"));
    const dates = items.filter((i: any) => i.date).map((i: any) => i.date);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  });

  test("omits rest days entirely", () => {
    expect(items.some((i: any) => i.date === "2026-08-02")).toBe(false);
    expect(items.some((i: any) => i.date === "2026-08-09")).toBe(false);
  });

  test("marks today", () => {
    const t = items.find((i: any) => i.kind === "today");
    expect(t.date).toBe("2026-08-03");
    expect(t.label).toBe("3 mi");
    expect(t.detail).toBe("+ strides");
  });

  test("places a shifted run on the date it was actually run", () => {
    const run = items.find((i: any) => i.kind === "long");
    expect(run.date).toBe("2026-08-01");
    expect(run.slotDate).toBe("2026-07-31");
    expect(run.shiftedFrom).toBe("2026-07-31");
    expect(run.activity.strava_id).toBe(1);
  });

  test("classifies a plain run separately from a long run", () => {
    const run = items.find((i: any) => i.kind === "run");
    expect(run.date).toBe("2026-07-30");
    expect(run.shiftedFrom).toBeNull();
    expect(run.activity.strava_id).toBe(4);
  });

  test("keeps missed sessions as their own item", () => {
    const missed = items.find((i: any) => i.kind === "missed");
    expect(missed.date).toBe("2026-08-01");
    expect(missed.label).toBe("Dead");
  });

  test("emits a week rule after the last item of each completed week", () => {
    const ruleIdx = kinds.indexOf("week-rule");
    expect(ruleIdx).toBeGreaterThan(-1);
    const rule: any = items[ruleIdx];
    expect(rule.week).toBe(4);
    expect(rule.actualMiles).toBeCloseTo(9.667, 3);
    expect(rule.recovery).toBe(true);
    // Everything before week 4's rule belongs to week 4 or week 5: week 3's
    // older day and its own rule must not have leaked in ahead of it.
    const before = items.slice(0, ruleIdx);
    expect(before.some((i: any) => i.date === "2026-07-22")).toBe(false);
    expect(before.some((i: any) => i.kind === "week-rule")).toBe(false);
    // The rule closes its own week, so the item immediately before it must
    // be week 4's own oldest day (the synthetic 2026-07-28 future item),
    // not an item from an older week and not the rule itself. This pins
    // "after the last item of the week" -- without it, hoisting the rule
    // push above the week's own day items would still pass every other
    // assertion here, since rule items carry no `.date` field.
    const prev: any = items[ruleIdx - 1];
    expect(prev.kind).not.toBe("week-rule");
    expect(prev.date).toBe("2026-07-28");
  });

  test("orders multiple week rules newest week first", () => {
    const ruleIndices = kinds.reduce((acc: number[], k: string, idx: number) => {
      if (k === "week-rule") acc.push(idx);
      return acc;
    }, []);
    expect(ruleIndices.length).toBe(2);
    const [first, second] = ruleIndices.map((idx: number) => items[idx]);
    expect(first.week).toBe(4);
    expect(second.week).toBe(3);
    expect(second.recovery).toBe(false);
    expect(second.actualMiles).toBeCloseTo(6.2, 3);
  });

  test("classifies lifts separately from runs", () => {
    const lift = items.find((i: any) => i.kind === "lift");
    expect(lift.label).toBe("Bench");
    expect(lift.activity.moving_time).toBe(2384);
  });

  test("an empty plan yields an empty list", () => {
    expect(buildJournal({ plan: { phases: [] }, weeks: [] }, "2026-08-03")).toEqual([]);
  });

  test("a rest day emits no 'today' item at all, not a rest placeholder", () => {
    // journal.html's scroll-to-today (Change 3) relies on this: on a rest
    // day there is nothing dated today in the feed to scroll to, so the
    // client must fall back to the most recent past entry instead.
    const restToday: any = {
      plan: { id: "10k-oct-2026", name: "10K Race Plan", phases: [], race: null },
      weeks: [
        {
          week: 5, weekStart: "2026-08-03", phase: "build", recovery: false,
          summary: { plannedRuns: 4, completedRuns: 0, plannedMiles: 14, actualMiles: 0 },
          days: [
            { date: "2026-08-02", dayOfWeek: 6, plan: { type: "run", miles: 3, label: "3 mi" }, status: "missed" },
            { date: "2026-08-03", dayOfWeek: 0, plan: { type: "rest", label: "rest" }, status: "rest" },
            { date: "2026-08-04", dayOfWeek: 1, plan: { type: "lift", label: "Squat" }, status: "upcoming" },
          ],
        },
      ],
    };
    const items = buildJournal(restToday, "2026-08-03");
    expect(items.some((i: any) => i.kind === "today")).toBe(false);
    expect(items.some((i: any) => i.date === "2026-08-03")).toBe(false);
    const kinds = items.map((i: any) => i.kind);
    expect(kinds).toEqual(["future", "missed", "week-rule"]);
  });
});

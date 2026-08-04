import { expect, test, describe } from "bun:test";
import { buildToday } from "../src/today";

const status: any = {
  plan: {
    id: "10k-oct-2026",
    name: "10K Race Plan",
    race: { name: "10K", date: "2026-10-03", targetPace: "~8:30/mi", targetTime: "52-53 min" },
    phases: [{ id: "build", name: "Build", tag: "4 runs / week", description: "Build desc", weeks: [5] }],
  },
  weeks: [
    {
      week: 4, weekStart: "2026-07-27", phase: "recovery-1", recovery: true,
      summary: { plannedRuns: 3, completedRuns: 3, plannedMiles: 9, actualMiles: 9.667 },
      days: [
        { date: "2026-07-30", dayOfWeek: 3, plan: { type: "run", miles: 3, label: "3 mi", detail: "easy" },
          status: "completed",
          actual: { strava_id: 19537874102, distance: 5006.1, moving_time: 1781, average_speed: 2.811,
                    average_heartrate: 141.4, name: "Half Moon Bay", type: "Run", date: "2026-07-30",
                    weather: { temp: 59.9, feels: 59.8, humidity: 86, wind: 4.5, code: 3 } } },
        { date: "2026-07-31", dayOfWeek: 4, plan: { type: "long", miles: 3.5, label: "3.5 mi", detail: "easy" },
          status: "completed", shiftedFrom: "2026-08-01",
          actual: { strava_id: 19559217595, distance: 6524.4, moving_time: 2326, average_speed: 2.805,
                    average_heartrate: 143.1, max_heartrate: 153, name: "Half Moon Bay", type: "Run", date: "2026-08-01",
                    weather: { temp: 56.2, feels: 57.4, humidity: 100, wind: 1.8, code: 45 } } },
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

const lookup = {
  splits: (id: number) => {
    if (id === 19559217595) {
      return [{ split_index: 0, distance: 1609.8, elapsed_time: 564, moving_time: 558, elevation_diff: -0.1, average_speed: 2.88, average_heartrate: 134.3, pace_zone: 3 }];
    }
    if (id === 19537874102) {
      return [{ split_index: 0, distance: 1609.3, elapsed_time: 590, moving_time: 590, elevation_diff: 1.2, average_speed: 2.73, average_heartrate: 140.1, pace_zone: 2 }];
    }
    return [];
  },
  // 19537874102 has splits but no feedback yet, exercising the degradation path.
  feedback: (id: number) => id === 19559217595
    ? { narrative: "Friday's long run, done Saturday.\n\n### Per mile\n\n- **Mile 1** ... 9:19", analysis_json: '{"deltas":{"hr_vs_baseline":-1.2}}' }
    : null,
};

describe("buildToday", () => {
  const view = buildToday(status, "2026-08-03", lookup);

  test("surfaces today's prescription", () => {
    expect(view.date).toBe("2026-08-03");
    expect(view.plan).toEqual({ type: "run", miles: 3, label: "3 mi", detail: "+ strides" });
  });

  test("reports the week and phase", () => {
    expect(view.week.number).toBe(5);
    expect(view.week.phase).toBe("build");
    expect(view.week.phaseName).toBe("Build");
    expect(view.week.recovery).toBe(false);
  });

  test("counts days to race from today, not from the plan start", () => {
    expect(view.race.date).toBe("2026-10-03");
    expect(view.race.daysAway).toBe(61);
  });

  test("finds the next non-rest session after today", () => {
    expect(view.next).toEqual({ date: "2026-08-04", label: "Squat" });
  });

  test("finds the most recent completed run, following a shift", () => {
    // The Jul 31 slot holds an Aug 1 activity, and there is a genuine Jul 30
    // run competing for "most recent". Sorting on actual date must pick the
    // Aug 1 run; a reversed comparator would return the Jul 30 run instead.
    expect(view.lastRun.strava_id).toBe(19559217595);
    expect(view.lastRun.strava_id).not.toBe(19537874102);
    expect(view.lastRun.date).toBe("2026-08-01");
    expect(view.lastRun.shiftedFrom).toBe("2026-07-31");
    expect(view.lastRun.splits).toHaveLength(1);
    expect(view.lastRun.narrative).toContain("Friday's long run");
    expect(view.lastRun.max_heartrate).toBe(153);
  });

  test("excludes a run whose actual date is still in the future, even when its slot is not", () => {
    // The Aug 1 activity sits in the Jul 31 slot. Filtering on the slot date
    // would wrongly include it on Jul 31; filtering on the actual date excludes it.
    const asOfJul31 = buildToday(status, "2026-07-31", lookup);
    expect(asOfJul31.lastRun.strava_id).toBe(19537874102);
    expect(asOfJul31.lastRun.date).toBe("2026-07-30");
    // This fixture activity carries no max_heartrate, so the field must come
    // through as absent rather than coerced to null or 0 -- the page's chip
    // guard (`if (r.max_heartrate)`) relies on it being falsy either way.
    expect(asOfJul31.lastRun.max_heartrate).toBeUndefined();
  });

  test("returns the trailing three weeks with the current one flagged", () => {
    expect(view.weeks).toHaveLength(2);
    const w5 = view.weeks.find((w: any) => w.number === 5);
    expect(w5.current).toBe(true);
    expect(w5.actualMiles).toBe(0);
    expect(w5.plannedMiles).toBe(14);
    const w4 = view.weeks.find((w: any) => w.number === 4);
    expect(w4.current).toBe(false);
    expect(w4.actualMiles).toBeCloseTo(9.667, 3);
  });

  test("a rest day yields a null plan but still builds", () => {
    const restView = buildToday(status, "2026-08-02", lookup);
    expect(restView.plan).toBeNull();
    expect(restView.week.number).toBe(4);
  });

  test("a date outside the plan yields nulls rather than throwing", () => {
    const outside = buildToday(status, "2027-01-01", lookup);
    expect(outside.plan).toBeNull();
    expect(outside.week).toBeNull();
  });

  test("degrades when the last run has no feedback", () => {
    const noFb = buildToday(status, "2026-08-03", { splits: lookup.splits, feedback: () => null });
    expect(noFb.lastRun.narrative).toBeNull();
    expect(noFb.lastRun.analysis).toBeNull();
    expect(noFb.lastRun.splits).toHaveLength(1);
  });
});

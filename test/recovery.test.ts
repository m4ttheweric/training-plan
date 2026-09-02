import { expect, test, describe } from "bun:test";
import { buildRecovery } from "../src/recovery";

// Two started weeks plus one future week, mirroring the shape getPlanStatus
// returns. Only the fields buildRecovery reads are populated.
const status: any = {
  plan: { id: "10k-oct-2026", name: "10K Race Plan" },
  weeks: [
    {
      week: 5, weekStart: "2026-08-03", phase: "build", recovery: false,
      summary: { actualMiles: 12 },
      days: [
        { date: "2026-08-04", plan: { type: "run" }, status: "completed", actual: { type: "Run" } },
        { date: "2026-08-05", plan: { type: "lift" }, status: "completed", actual: { type: "WeightTraining" } },
        { date: "2026-08-06", plan: { type: "run" }, status: "missed", extra: [{ type: "Run" }] },
        { date: "2026-08-09", plan: { type: "rest" }, status: "rest" },
      ],
    },
    {
      week: 6, weekStart: "2026-08-10", phase: "build", recovery: true,
      summary: { actualMiles: 20 },
      days: [
        { date: "2026-08-11", plan: { type: "long" }, status: "completed", actual: { type: "Run" } },
      ],
    },
    {
      week: 7, weekStart: "2026-08-17", phase: "build", recovery: false,
      summary: { actualMiles: 0 },
      days: [{ date: "2026-08-17", plan: { type: "run" }, status: "upcoming" }],
    },
  ],
};

const sleep = [
  { date: "2026-08-04", metric: "sleep_total", value: 7.5 },
  { date: "2026-08-04", metric: "sleep_deep", value: 1.2 },
  { date: "2026-08-05", metric: "sleep_total", value: 6.0 },
  { date: "2026-08-05", metric: "sleep_deep", value: 0.9 },
  // Implausible >12h night: dropped, and its deep must not sneak into the mean.
  { date: "2026-08-06", metric: "sleep_total", value: 13.0 },
  { date: "2026-08-06", metric: "sleep_deep", value: 2.0 },
  { date: "2026-08-11", metric: "sleep_total", value: 8.0 },
  { date: "2026-08-11", metric: "sleep_deep", value: 1.5 },
  // A stray night that belongs to the excluded future week: must not appear.
  { date: "2026-08-18", metric: "sleep_total", value: 5.0 },
];

describe("buildRecovery", () => {
  const rec = buildRecovery(status, sleep, "2026-08-14");

  test("drops future weeks whose start is after the as-of date", () => {
    expect(rec.weeks.map((w) => w.week)).toEqual([5, 6]);
  });

  test("flags the week containing the as-of date as current", () => {
    // 2026-08-14 falls in week 6's Mon-Sun span (08-10..08-16), not week 5's.
    expect(rec.weeks.find((w) => w.week === 5)!.current).toBe(false);
    expect(rec.weeks.find((w) => w.week === 6)!.current).toBe(true);
  });

  test("hides a started week with neither a run nor a scored night", () => {
    const withEmpty: any = {
      plan: status.plan,
      weeks: [
        status.weeks[0],
        { week: 6, weekStart: "2026-08-10", recovery: false, summary: { actualMiles: 0 }, days: [] },
      ],
    };
    const r = buildRecovery(withEmpty, sleep.filter((s) => s.date < "2026-08-10"), "2026-08-14");
    expect(r.weeks.map((w) => w.week)).toEqual([5]);
  });

  test("buckets sleep into the week its morning belongs to", () => {
    const w5 = rec.weeks.find((w) => w.week === 5)!;
    expect(w5.nights).toBe(2);
    expect(w5.avgSleep).toBeCloseTo(6.75, 5);
    expect(w5.avgDeep).toBeCloseTo(1.05, 5);
  });

  test("the >12h guard drops the night and its deep sample", () => {
    const w5 = rec.weeks.find((w) => w.week === 5)!;
    // 13h night excluded: nights stays 2, and deep averages only 1.2 and 0.9.
    expect(w5.nights).toBe(2);
    expect(w5.avgDeep).toBeCloseTo(1.05, 5);
  });

  test("carries plan load through unchanged", () => {
    const w5 = rec.weeks.find((w) => w.week === 5)!;
    expect(w5.miles).toBe(12);
    // One run slot with an actual, plus one stray on the missed day.
    expect(w5.runs).toBe(2);
    expect(w5.recovery).toBe(false);
    expect(rec.weeks.find((w) => w.week === 6)!.recovery).toBe(true);
  });

  test("summarises the plan window night-weighted, not week-weighted", () => {
    // (7.5 + 6.0 + 8.0) / 3 nights, NOT the mean of the two weekly averages.
    expect(rec.planAvgSleep).toBeCloseTo(7.1667, 3);
    expect(rec.weeksWithSleep).toBe(2);
    expect(rec.weeksAtTarget).toBe(1); // only week 6's 8.0h clears 7h
  });

  test("a week with no sleep rows reports null averages, not zero", () => {
    const bare = buildRecovery(status, [], "2026-08-14");
    expect(bare.weeks[0]!.avgSleep).toBeNull();
    expect(bare.weeks[0]!.avgDeep).toBeNull();
    expect(bare.weeks[0]!.nights).toBe(0);
    expect(bare.planAvgSleep).toBeNull();
  });

  test("an as-of before every week yields no rows rather than throwing", () => {
    expect(buildRecovery(status, sleep, "2026-01-01").weeks).toEqual([]);
  });
});

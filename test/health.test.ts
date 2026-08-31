import { expect, test, describe } from "bun:test";
import { parseHealthExport } from "../src/health";

function wrap(metrics: unknown[]) {
  return { data: { metrics } };
}

function find(rows: ReturnType<typeof parseHealthExport>, metric: string, date = "2026-08-14") {
  return rows.find((r) => r.metric === metric && r.date === date);
}

describe("parseHealthExport", () => {
  test("a plain qty metric becomes one row per day", () => {
    const rows = parseHealthExport(wrap([
      {
        name: "resting_heart_rate",
        units: "count/min",
        data: [
          { date: "2026-08-14 00:00:00 -0500", qty: 53, source: "Watch" },
          { date: "2026-08-15 00:00:00 -0500", qty: 55, source: "Watch" },
        ],
      },
    ]));

    expect(rows).toHaveLength(2);
    expect(find(rows, "resting_heart_rate")).toEqual({
      date: "2026-08-14", metric: "resting_heart_rate", value: 53, units: "count/min",
    });
  });

  test("heart_rate expands into its avg, max and min series", () => {
    const rows = parseHealthExport(wrap([
      {
        name: "heart_rate",
        units: "count/min",
        data: [{ date: "2026-08-14 00:00:00 -0500", Avg: 78.2, Max: 170, Min: 48 }],
      },
    ]));

    expect(find(rows, "heart_rate_avg")?.value).toBe(78.2);
    expect(find(rows, "heart_rate_max")?.value).toBe(170);
    expect(find(rows, "heart_rate_min")?.value).toBe(48);
    expect(find(rows, "heart_rate")).toBeUndefined();
  });

  test("sleep_analysis expands into per-stage hours", () => {
    const rows = parseHealthExport(wrap([
      {
        name: "sleep_analysis",
        units: "hr",
        data: [{
          date: "2026-08-14 00:00:00 -0500",
          totalSleep: 7.2877, core: 4.0062, rem: 2.2821, deep: 0.9995, awake: 0.1999,
          sleepStart: "2026-08-13 23:01:42 -0500",
          sleepEnd: "2026-08-14 06:30:57 -0500",
        }],
      },
    ]));

    expect(find(rows, "sleep_total")?.value).toBeCloseTo(7.2877, 4);
    expect(find(rows, "sleep_core")?.value).toBeCloseTo(4.0062, 4);
    expect(find(rows, "sleep_rem")?.value).toBeCloseTo(2.2821, 4);
    expect(find(rows, "sleep_deep")?.value).toBeCloseTo(0.9995, 4);
    expect(find(rows, "sleep_awake")?.value).toBeCloseTo(0.1999, 4);
  });

  test("a bedtime before midnight is a negative offset from the sleep date", () => {
    const rows = parseHealthExport(wrap([
      {
        name: "sleep_analysis",
        units: "hr",
        data: [{
          date: "2026-08-14 00:00:00 -0500",
          totalSleep: 7.2877,
          sleepStart: "2026-08-13 23:01:42 -0500",
          sleepEnd: "2026-08-14 06:30:57 -0500",
        }],
      },
    ]));

    expect(find(rows, "sleep_start_offset")?.value).toBeCloseTo(-0.9717, 3);
    expect(find(rows, "sleep_end_offset")?.value).toBeCloseTo(6.5158, 3);
  });

  test("a bedtime after midnight is a positive offset", () => {
    const rows = parseHealthExport(wrap([
      {
        name: "sleep_analysis",
        units: "hr",
        data: [{
          date: "2026-08-14 00:00:00 -0500",
          totalSleep: 6,
          sleepStart: "2026-08-14 00:45:00 -0500",
          sleepEnd: "2026-08-14 06:45:00 -0500",
        }],
      },
    ]));

    expect(find(rows, "sleep_start_offset")?.value).toBeCloseTo(0.75, 3);
  });

  test("entries without a usable number are dropped rather than stored as zero", () => {
    const rows = parseHealthExport(wrap([
      {
        name: "vo2_max",
        units: "ml/(kg·min)",
        data: [
          { date: "2026-08-14 00:00:00 -0500", qty: null },
          { date: "2026-08-15 00:00:00 -0500", qty: "not a number" },
          { date: "2026-08-16 00:00:00 -0500" },
          { date: "2026-08-17 00:00:00 -0500", qty: 52.4 },
        ],
      },
    ]));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(52.4);
  });

  test("entries without a parseable date are dropped", () => {
    const rows = parseHealthExport(wrap([
      {
        name: "step_count",
        units: "count",
        data: [
          { date: "not-a-date", qty: 100 },
          { qty: 200 },
          { date: "2026-08-14 00:00:00 -0500", qty: 300 },
        ],
      },
    ]));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(300);
  });

  test("a shape that is not a Health Auto Export payload yields nothing", () => {
    expect(parseHealthExport(null)).toEqual([]);
    expect(parseHealthExport({})).toEqual([]);
    expect(parseHealthExport({ data: {} })).toEqual([]);
    expect(parseHealthExport({ data: { metrics: "nope" } })).toEqual([]);
    expect(parseHealthExport({ data: { metrics: [{ name: "x" }] } })).toEqual([]);
  });

  test("a metric with no name is skipped rather than stored under undefined", () => {
    const rows = parseHealthExport(wrap([
      { units: "count", data: [{ date: "2026-08-14 00:00:00 -0500", qty: 1 }] },
    ]));

    expect(rows).toEqual([]);
  });
});

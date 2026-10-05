import { describe, expect, test } from "bun:test";
import { chooseDefaultPlan, validatePlan } from "../src/plan-schema";

const original = await Bun.file(new URL("../plans/10k-oct-2026.json", import.meta.url)).json();
const copy = () => structuredClone(original);

describe("plan contract", () => {
  test("accepts the existing plan without changing its data", () => {
    expect(validatePlan(original, "10k-oct-2026")).toEqual(original);
  });

  test.each([
    ["unsupported day type", (p: any) => p.weeks[0].days[0].type = "easy"],
    ["missing run mileage", (p: any) => delete p.weeks[0].days[0].miles],
    ["zero run mileage", (p: any) => p.weeks[0].days[0].miles = 0],
    ["kilometers in a miles format", (p: any) => p.weeks[0].days[0].km = 5],
    ["six days in a week", (p: any) => p.weeks[0].days.pop()],
    ["impossible calendar date", (p: any) => p.startDate = "2026-02-30"],
    ["Wednesday anchor", (p: any) => p.startDate = "2026-07-08"],
    ["skipped week number", (p: any) => p.weeks[1].week = 3],
    ["unassigned phase week", (p: any) => p.phases[0].weeks.shift()],
    ["overlapping phase weeks", (p: any) => p.phases[1].weeks.push(1)],
    ["nonexistent phase week", (p: any) => p.phases[0].weeks.push(99)],
    ["duplicate phase ID", (p: any) => p.phases[1].id = p.phases[0].id],
    ["race on the wrong day", (p: any) => p.race.date = "2026-10-02"],
    ["race outside the plan", (p: any) => p.race.date = "2027-10-03"],
    ["invalid plan ID", (p: any) => p.id = "../private"],
  ])("rejects %s", (_label, mutate) => {
    const p = copy(); mutate(p);
    expect(() => validatePlan(p)).toThrow();
  });

  test("rejects a filename that disagrees with the plan ID", () => {
    expect(() => validatePlan(original, "different-plan")).toThrow(/id/i);
  });

  test("supports maintenance plans without race metadata", () => {
    const p = copy(); delete p.race;
    p.weeks[12].days[5] = { type: "run", miles: 3 };
    expect(validatePlan(p)).toEqual(p);
  });
});


describe("default plan selection", () => {
  const plans = [
    { id: "old", startDate: "2026-07-06", weeks: [{}, {}] },
    { id: "current", startDate: "2026-10-05", weeks: [{}, {}] },
    { id: "future", startDate: "2026-11-02", weeks: [{}] },
  ] as any;
  test("chooses the current plan instead of alphabetic filename order", () => {
    expect(chooseDefaultPlan(plans, "2026-10-05").id).toBe("current");
  });
  test("uses the most recently completed plan between plans", () => {
    expect(chooseDefaultPlan(plans, "2026-10-22").id).toBe("current");
  });
  test("uses the earliest upcoming plan before any start", () => {
    expect(chooseDefaultPlan(plans, "2026-01-01").id).toBe("old");
  });
});

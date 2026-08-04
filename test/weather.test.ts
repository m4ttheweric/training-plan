import { expect, test, describe } from "bun:test";
import { pickWeatherEndpoint } from "../src/weather";

const FORECAST = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";

describe("pickWeatherEndpoint", () => {
  test("a date well in the past picks the archive endpoint", () => {
    expect(pickWeatherEndpoint("2018-06-01", "2026-08-03")).toBe(ARCHIVE);
    expect(pickWeatherEndpoint("2026-03-19", "2026-08-03")).toBe(ARCHIVE);
  });

  test("today or yesterday picks the forecast endpoint", () => {
    expect(pickWeatherEndpoint("2026-08-03", "2026-08-03")).toBe(FORECAST);
    expect(pickWeatherEndpoint("2026-08-02", "2026-08-03")).toBe(FORECAST);
  });

  test("the boundary is inclusive of the forecast endpoint at exactly the cutoff", () => {
    // ARCHIVE_CUTOFF_DAYS is 7: exactly 7 days old still tries forecast
    // first, 8 days old is the first to try archive first.
    expect(pickWeatherEndpoint("2026-07-27", "2026-08-03")).toBe(FORECAST);
    expect(pickWeatherEndpoint("2026-07-26", "2026-08-03")).toBe(ARCHIVE);
  });
});

import { describe, expect, test } from "bun:test";
import { getServerConfig } from "../src/config";

describe("portable local configuration", () => {
  test("defaults to loopback and a matching OAuth callback origin", () => {
    expect(getServerConfig({})).toEqual({ port: 8081, hostname: "127.0.0.1", baseUrl: "http://localhost:8081" });
  });
  test("derives the callback from a custom port", () => {
    expect(getServerConfig({ PORT: "9000" }).baseUrl).toBe("http://localhost:9000");
  });
  test("preserves an explicitly configured proxy origin", () => {
    expect(getServerConfig({ BASE_URL: "https://training.localhost/" }).baseUrl).toBe("https://training.localhost");
  });
  test.each(["oops", "8081oops", "0", "65536", "-1", "8081.5"])("rejects invalid port %s", port => {
    expect(() => getServerConfig({ PORT: port })).toThrow(/PORT/);
  });
  test("rejects a non-HTTP callback", () => {
    expect(() => getServerConfig({ BASE_URL: "file:///tmp/plan" })).toThrow(/BASE_URL/);
  });
});

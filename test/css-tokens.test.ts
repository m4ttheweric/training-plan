import { expect, test, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const css = readFileSync(join(import.meta.dir, "../public/app.css"), "utf-8");

function declaredIn(block: string): Set<string> {
  const names = new Set<string>();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(m[1]);
  return names;
}

// Grab a brace-balanced block starting at the first index of `marker`.
function blockAfter(marker: string): string {
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  let depth = 0, i = css.indexOf("{", start);
  const open = i;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) return css.slice(open, i); }
  }
  throw new Error(`unbalanced block: ${marker}`);
}

describe("app.css tokens", () => {
  test("every var(--x) used is defined in :root", () => {
    const defined = declaredIn(blockAfter(":root {"));
    const used = new Set<string>();
    for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1]);
    const missing = [...used].filter(n => !defined.has(n));
    expect(missing).toEqual([]);
  });

  test("the two dark declarations define exactly the same tokens", () => {
    const media = declaredIn(blockAfter("@media (prefers-color-scheme: dark)"));
    const attr = declaredIn(blockAfter('[data-theme="dark"] {'));
    expect([...attr].sort()).toEqual([...media].sort());
  });

  test("dark overrides every colour token, and no layout token", () => {
    const dark = declaredIn(blockAfter('[data-theme="dark"] {'));
    const mustOverride = [
      "--ink", "--ink2", "--ink3", "--hair", "--wash", "--paper",
      "--run-bg", "--run-fg", "--long-bg", "--long-fg", "--lift-bg", "--lift-fg",
      "--good", "--bad", "--hatch-a", "--hatch-b", "--hatch-fg", "--sun-head", "--pin-shadow",
    ];
    for (const t of mustOverride) expect(dark.has(t)).toBe(true);
    for (const t of ["--sans", "--pad", "--maxw"]) expect(dark.has(t)).toBe(false);
  });

  test("accent is identical in light and dark (variant A)", () => {
    const light = blockAfter(":root {");
    const dark = blockAfter('[data-theme="dark"] {');
    const pick = (b: string) => b.match(/--accent:\s*([^;]+);/)![1].trim();
    expect(pick(dark)).toBe(pick(light));
  });

  test("no hardcoded hex outside the token blocks", () => {
    // Hardcoded colours in component rules are what broke dark mode twice.
    // #fff is allowed: it is text on the always-saturated accent block.
    const body = css
      .replace(blockAfter(":root {"), "")
      .replace(blockAfter("@media (prefers-color-scheme: dark)"), "")
      .replace(blockAfter('[data-theme="dark"] {'), "");
    const hexes = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)]
      .map(m => m[0].toLowerCase())
      .filter(h => h !== "#fff" && h !== "#ffffff");
    expect(hexes).toEqual([]);
  });

  test("no em or en dashes", () => {
    expect(css.includes("—")).toBe(false);
    expect(css.includes("–")).toBe(false);
  });
});

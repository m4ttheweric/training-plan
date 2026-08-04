import { expect, test, describe } from "bun:test";
import {
  esc, fmtMiles, fmtPaceFromSpeed, fmtDuration,
  fmtDayLabel, fmtWeekday, renderMarkdown, localDate,
} from "../public/lib.js";

/* Run a one-line script under an explicit TZ in a subprocess. localDate's
   whole point is to depend on the local timezone, so testing it must not
   depend on whatever timezone the test runner happens to be in. */
function runIn(tz: string, expr: string): string {
  const p = Bun.spawnSync({
    cmd: ["bun", "-e", expr],
    env: { ...process.env, TZ: tz },
  });
  return new TextDecoder().decode(p.stdout).trim();
}

describe("formatting", () => {
  test("fmtMiles converts metres to two decimals", () => {
    expect(fmtMiles(6524.4)).toBe("4.05");
    expect(fmtMiles(5006.1)).toBe("3.11");
    expect(fmtMiles(0)).toBe("0.00");
  });

  test("fmtPaceFromSpeed converts m/s to min/mi", () => {
    expect(fmtPaceFromSpeed(2.805)).toBe("9:34");
    expect(fmtPaceFromSpeed(2.811)).toBe("9:33");
    expect(fmtPaceFromSpeed(0)).toBe("--");
  });

  test("fmtDuration pads and adds hours only when needed", () => {
    expect(fmtDuration(2326)).toBe("38:46");
    expect(fmtDuration(4758)).toBe("1:19:18");
    expect(fmtDuration(65)).toBe("1:05");
    expect(fmtDuration(0)).toBe("0:00");
  });

  test("date helpers read the ISO date without timezone drift", () => {
    expect(fmtDayLabel("2026-08-01")).toBe("Sat Aug 1");
    expect(fmtDayLabel("2026-08-03T20:15:27Z")).toBe("Mon Aug 3");
    expect(fmtWeekday("2026-08-02")).toBe("Sun");
  });

  test("esc neutralises HTML", () => {
    expect(esc('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"
    );
    expect(esc("a & b")).toBe("a &amp; b");
  });
});

describe("localDate", () => {
  test("returns the local calendar date, not the UTC date", () => {
    // 00:25 UTC on Aug 4 is still the evening of Aug 3 in Chicago.
    const libPath = new URL("../public/lib.js", import.meta.url).pathname;
    const expr =
      `const {localDate} = await import(${JSON.stringify(libPath)});` +
      'console.log(localDate(new Date("2026-08-04T00:25:00Z")));';
    expect(runIn("America/Chicago", expr)).toBe("2026-08-03");
    expect(runIn("UTC", expr)).toBe("2026-08-04");
  });
});

describe("renderMarkdown", () => {
  test("renders headings as section rules", () => {
    expect(renderMarkdown("### Per mile")).toBe('<h3 class="sec-h">Per mile</h3>');
    expect(renderMarkdown("## Effort")).toBe('<h3 class="sec-h">Effort</h3>');
  });

  test("renders bold inside paragraphs", () => {
    expect(renderMarkdown("ran **4.05 mi** today")).toBe(
      "<p>ran <b>4.05 mi</b> today</p>"
    );
  });

  test("groups consecutive dashes into one list", () => {
    expect(renderMarkdown("- one\n- two")).toBe(
      "<ul><li>one</li><li>two</li></ul>"
    );
  });

  test("separates paragraphs on blank lines", () => {
    expect(renderMarkdown("first\n\nsecond")).toBe("<p>first</p><p>second</p>");
  });

  test("escapes HTML in the source", () => {
    expect(renderMarkdown("<script>x</script>")).toBe(
      "<p>&lt;script&gt;x&lt;/script&gt;</p>"
    );
  });

  test("handles the real narrative shape without leaking syntax", () => {
    const md = [
      "### Per mile",
      "",
      "- **Mile 1** ... 9:19/mi, HR 134",
      "- **Mile 3** ... 9:47/mi, HR 145",
      "",
      "Mile 3 was slowest despite **-17 ft** net.",
    ].join("\n");
    const html = renderMarkdown(md);
    expect(html).toContain('<h3 class="sec-h">Per mile</h3>');
    expect(html).toContain("<li><b>Mile 1</b> ... 9:19/mi, HR 134</li>");
    expect(html).toContain("<p>Mile 3 was slowest despite <b>-17 ft</b> net.</p>");
    expect(html).not.toContain("###");
    expect(html).not.toContain("**");
  });

  test("empty input yields empty output", () => {
    expect(renderMarkdown("")).toBe("");
  });
});

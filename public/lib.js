/* Pure helpers shared by every page.
 *
 * This file is served verbatim to browsers AND imported directly by the
 * server (src/plan.ts, src/today.ts, src/journal.ts import localDate from
 * here). There is no bundler and no transform step, so it must stay free of
 * DOM and Node access: anything that touches `document`, `window`, `fs` or
 * `process` breaks the server the moment it is imported. Adding an export
 * is safe; changing an existing signature is not, because three server
 * modules and public/lib.d.ts depend on them. */

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const METRES_PER_MILE = 1609.34;

/* The calendar date as the user's local wall clock sees it, not the UTC
   date. Using toISOString().slice(0, 10) instead would report tomorrow's
   date starting at 19:00 CDT / 18:00 CST, since it reads the UTC day. */
export function localDate(d = new Date()) {
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fmtMiles(meters) {
  return ((meters || 0) / METRES_PER_MILE).toFixed(2);
}

function mmss(totalSeconds) {
  const s = Math.round(totalSeconds);
  const m = Math.floor(s / 60);
  return m + ":" + String(s % 60).padStart(2, "0");
}

export function fmtPaceFromSpeed(mps) {
  if (!mps || mps <= 0) return "--";
  return mmss(METRES_PER_MILE / mps);
}

export function fmtDuration(seconds) {
  const s = Math.round(seconds || 0);
  if (s < 3600) return mmss(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h + ":" + String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

/* Parse the calendar date out of an ISO string without constructing a Date in
   local time, which would shift the day either side of midnight. */
function parts(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

export function fmtDayLabel(iso) {
  const p = parts(iso);
  return DAYS[p.dow] + " " + MONTHS[p.m - 1] + " " + p.d;
}

export function fmtWeekday(iso) {
  return DAYS[parts(iso).dow];
}

/* Deliberately small markdown subset: headings, bold, unordered lists,
   paragraphs. Tables are not supported because tabular content comes from
   the splits endpoint and analysis_json, never from prose. */
export function renderMarkdown(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = [];
  let list = [];

  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  const flushPara = () => {
    if (para.length) out.push("<p>" + inline(para.join(" ")) + "</p>");
    para = [];
  };
  const flushList = () => {
    if (list.length) out.push("<ul>" + list.map(i => "<li>" + inline(i) + "</li>").join("") + "</ul>");
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushList(); flushPara(); continue; }

    const heading = line.match(/^#{2,4}\s+(.*)$/);
    if (heading) {
      flushList(); flushPara();
      out.push('<h3 class="sec-h">' + inline(heading[1]) + "</h3>");
      continue;
    }

    const item = line.match(/^[-*]\s+(.*)$/);
    if (item) { flushPara(); list.push(item[1]); continue; }

    flushList();
    para.push(line);
  }
  flushList(); flushPara();
  return out.join("");
}

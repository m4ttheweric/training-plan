// Hand-synced with lib.js; nothing enforces that automatically, so only
// `tsc --noEmit` will catch it if these signatures drift out of step.
export function localDate(d?: Date): string;
export function esc(s: unknown): string;
export function fmtMiles(meters: number): string;
export function fmtPaceFromSpeed(mps: number): string;
export function fmtDuration(seconds: number): string;
export function fmtDayLabel(iso: string): string;
export function fmtWeekday(iso: string): string;
export function renderMarkdown(md: string): string;

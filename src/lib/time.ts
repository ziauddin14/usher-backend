// Dates in Demo v1: a jadwal's `date` is the Asia/Karachi calendar day as YYYY-MM-DD.
// Never derive it from a UTC timestamp without going through these helpers.

const TIME_ZONE = 'Asia/Karachi';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const karachiFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Karachi local date (YYYY-MM-DD) of an instant. */
export function karachiDate(at: Date = new Date()): string {
  return karachiFormat.format(at);
}

/** Karachi local month (YYYY-MM) of an instant. */
export function karachiMonth(at: Date = new Date()): string {
  return karachiDate(at).slice(0, 7);
}

/** True for a real calendar date in YYYY-MM-DD form. */
export function isDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Add whole days to a YYYY-MM-DD date (pure calendar arithmetic, no time zone involved). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Month (YYYY-MM) of a YYYY-MM-DD date. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** Day of week of a YYYY-MM-DD date: 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

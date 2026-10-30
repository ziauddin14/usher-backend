import { describe, expect, it } from 'vitest';
import { addDays, isDateString, karachiDate, karachiMonth, monthOf, weekday } from './time.js';

describe('Karachi date helpers', () => {
  it('uses the Karachi calendar day, not the UTC day', () => {
    // 19:30 UTC is 00:30 the next day in Karachi (UTC+5).
    expect(karachiDate(new Date('2026-10-29T19:30:00Z'))).toBe('2026-10-30');
    expect(karachiDate(new Date('2026-10-29T18:59:59Z'))).toBe('2026-10-29');
    expect(karachiDate(new Date('2026-10-29T19:00:00Z'))).toBe('2026-10-30');
  });

  it('gives the Karachi month across a month boundary', () => {
    expect(karachiMonth(new Date('2026-10-31T19:30:00Z'))).toBe('2026-11');
    expect(monthOf('2026-06-01')).toBe('2026-06');
  });

  it('adds days across months and years', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('validates YYYY-MM-DD strings', () => {
    expect(isDateString('2026-10-30')).toBe(true);
    expect(isDateString('2026-02-30')).toBe(false);
    expect(isDateString('30-10-2026')).toBe(false);
  });

  it('returns the weekday (0 = Sunday)', () => {
    expect(weekday('2026-10-30')).toBe(5); // Friday
  });
});

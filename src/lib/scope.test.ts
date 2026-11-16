import { describe, expect, it } from 'vitest';
import { AppError } from './errors.js';
import { assertInScope, escapeRegex, isInScope, rootOf, scopeFilter } from './scope.js';

const sukkur = { unitPath: 'PK/INT_SINDH/SUKKUR' };

describe('scopeFilter', () => {
  it('builds an anchored prefix regex on unitPath', () => {
    expect(scopeFilter(sukkur)).toEqual({ unitPath: { $regex: '^PK/INT_SINDH/SUKKUR(/|$)' } });
  });

  it('matches the unit itself and its descendants only', () => {
    const re = new RegExp((scopeFilter(sukkur).unitPath as { $regex: string }).$regex);
    expect(re.test('PK/INT_SINDH/SUKKUR')).toBe(true);
    expect(re.test('PK/INT_SINDH/SUKKUR/GHOTKI')).toBe(true);
    // A sibling whose code starts with the same letters must not match.
    expect(re.test('PK/INT_SINDH/SUKKUR_DIST')).toBe(false);
    expect(re.test('PK/INT_SINDH/LARKANA/DADU')).toBe(false);
    expect(re.test('XPK/INT_SINDH/SUKKUR')).toBe(false);
  });

  it('can target another field name', () => {
    expect(scopeFilter(sukkur, 'path')).toEqual({ path: { $regex: '^PK/INT_SINDH/SUKKUR(/|$)' } });
  });

  it('escapes regex characters in codes', () => {
    expect(escapeRegex('A.B*C')).toBe('A\\.B\\*C');
  });
});

describe('isInScope / assertInScope', () => {
  it('accepts own unit and descendants', () => {
    expect(isInScope(sukkur, 'PK/INT_SINDH/SUKKUR/GHOTKI')).toBe(true);
    expect(isInScope({ unitPath: 'PK' }, 'PK/PUNJAB/GUJRAT/GUJRAT_DIST')).toBe(true);
  });

  it('rejects parents and siblings with 404', () => {
    expect(isInScope(sukkur, 'PK/INT_SINDH')).toBe(false);
    expect(() => assertInScope(sukkur, { unitPath: 'PK/INT_SINDH/LARKANA' })).toThrow(AppError);
    expect(() => assertInScope(sukkur, null)).toThrow(/Not found/);
  });
});

describe('extra units (CTO 17 Nov 2026)', () => {
  const zahid = { unitPath: 'PK/INT_SINDH/LARKANA', extraUnitPaths: ['PK/INT_SINDH/SUKKUR'] };

  it('sees the own unit and the extra unit, nothing else', () => {
    expect(isInScope(zahid, 'PK/INT_SINDH/LARKANA/DADU')).toBe(true);
    expect(isInScope(zahid, 'PK/INT_SINDH/SUKKUR/GHOTKI')).toBe(true);
    expect(isInScope(zahid, 'PK/INT_SINDH/HYDERABAD')).toBe(false);
    expect(isInScope(zahid, 'PK/INT_SINDH')).toBe(false);
  });

  it('filters with one anchored prefix per root', () => {
    const f = scopeFilter(zahid).unitPath as { $in: RegExp[] };
    expect(f.$in).toHaveLength(2);
    const ok = (p: string) => f.$in.some((re) => re.test(p));
    expect(ok('PK/INT_SINDH/SUKKUR/GHOTKI')).toBe(true);
    expect(ok('PK/INT_SINDH/SUKKUR_X')).toBe(false);
    expect(ok('PK/INT_SINDH/HYDERABAD')).toBe(false);
  });

  it('knows which root holds a path', () => {
    expect(rootOf(zahid, 'PK/INT_SINDH/SUKKUR/GHOTKI')).toBe('PK/INT_SINDH/SUKKUR');
    expect(rootOf(zahid, 'PK/INT_SINDH/LARKANA')).toBe('PK/INT_SINDH/LARKANA');
    expect(rootOf(zahid, 'PK/PUNJAB')).toBeNull();
  });
});

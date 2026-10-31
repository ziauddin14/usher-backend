import { describe, expect, it } from 'vitest';
import { DistrictNames, parseCsv, readDistrictNames } from './district-names.js';

describe('district names mapping', () => {
  it('parses quoted CSV fields', () => {
    expect(parseCsv('﻿a,b\r\n"x, ""y""",z\n')).toEqual([
      ['a', 'b'],
      ['x, "y"', 'z'],
    ]);
  });

  it('the committed file is well-formed: unique village-list spellings, Roman for each Urdu name', () => {
    const rows = readDistrictNames();
    expect(rows.length).toBeGreaterThan(50);
    const spellings = rows.flatMap((r) => r.villageFileNames);
    expect(new Set(spellings).size).toBe(spellings.length);
    for (const r of rows) {
      if (r.districtUr) expect(r.districtRoman, r.districtUr).not.toBe('');
      if (r.divisionUr) expect(r.divisionRoman, r.divisionUr).not.toBe('');
    }
  });

  it('looks up Roman names and village-list spellings', () => {
    const names = DistrictNames.load();
    expect(names.romanFor('suba', ['اندرون سندھ'])).toBe('Interior Sindh');
    expect(names.romanFor('district', ['اندرون سندھ', 'سکھر', 'گھوٹکی'])).toBe('Ghotki');
    expect(names.forVillageFileName('District Bahawalnager')).toEqual({
      subaUr: 'پنجاب',
      divisionUr: 'بہاولپور',
      districtUr: 'بہاولنگر',
    });
    expect(names.forVillageFileName('Lesbela District')).toBeUndefined(); // no district in the list
  });
});

import { describe, expect, it } from 'vitest';
import { looseVillageKey, villageNameKey } from './text.js';

describe('villageNameKey', () => {
  it('drops the goth prefix and extra spaces', () => {
    expect(villageNameKey('  گوٹھ   رحیم   آباد ')).toBe('رحیم آباد');
    expect(villageNameKey('Goth Rahim Abad')).toBe('rahim abad');
  });

  it('unifies Arabic and Urdu letter variants', () => {
    expect(villageNameKey('كريم')).toBe(villageNameKey('کریم'));
  });

  it('keeps names that only contain the word inside', () => {
    expect(villageNameKey('رحیم گوٹھ')).toBe('رحیم گوٹھ');
  });
});

describe('looseVillageKey (duplicate suggestions only)', () => {
  it('ignores spaces, punctuation, diacritics and common letter variants', () => {
    expect(looseVillageKey('گوٹھ پیر بخش')).toBe(looseVillageKey('پیربخش'));
    expect(looseVillageKey('چک-۱۲')).toBe(looseVillageKey('چک ۱۲'));
    expect(looseVillageKey('بستیِ نور')).toBe(looseVillageKey('بستی نور'));
    expect(looseVillageKey('Rahim Abad')).toBe(looseVillageKey('rahimabad'));
  });

  it('keeps different names apart', () => {
    expect(looseVillageKey('رحیم آباد')).not.toBe(looseVillageKey('کریم آباد'));
  });
});

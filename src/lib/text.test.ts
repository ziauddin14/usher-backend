import { describe, expect, it } from 'vitest';
import { villageNameKey } from './text.js';

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

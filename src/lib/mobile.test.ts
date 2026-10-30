import { describe, expect, it } from 'vitest';
import { maskMobile, normalizeMobile } from './mobile.js';

describe('normalizeMobile', () => {
  it('accepts the usual ways a Pakistani mobile is written', () => {
    for (const input of [
      '03001234567',
      '0300-1234567',
      '0300 1234567',
      '+92 300 1234567',
      '923001234567',
      '00923001234567',
      '3001234567',
      3001234567,
    ]) {
      expect(normalizeMobile(input)).toBe('03001234567');
    }
  });

  it('rejects anything else', () => {
    for (const input of ['', '123', '0211234567', '04001234567', '030012345678', null, undefined]) {
      expect(normalizeMobile(input)).toBeNull();
    }
  });
});

describe('maskMobile', () => {
  it('keeps only the first 4 and last 4 digits', () => {
    expect(maskMobile('03001234567')).toBe('0300•••4567');
    expect(maskMobile(undefined)).toBeNull();
  });
});

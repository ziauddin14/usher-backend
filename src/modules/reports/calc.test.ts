import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings/defaults.js';
import { computeDayTotals, type JadwalInput, visitAtiyatTotals } from './calc.js';

const categories = DEFAULT_SETTINGS.atiyatCategories;

// The Step 2 smoke-test day: ushr jins 3,000 + mahana naqd 1,500 + tameer 1,000 + GSB 2 boxes 2,000.
const smokeAtiyat = {
  entries: [
    {
      type: 'wusooli' as const,
      category: 'ushr',
      kind: 'jins' as const,
      amount: 3000,
      detail: 'گندم 2 من',
    },
    { type: 'wusooli' as const, category: 'mahana', kind: 'naqd' as const, amount: 1500 },
    { type: 'wusooli' as const, category: 'tameer', kind: 'naqd' as const, amount: 1000 },
    { type: 'niyyat' as const, category: 'ushr', kind: 'jins' as const, amount: 25000 },
  ],
  gsb: { boxesOpened: 2, amount: 2000 },
};

describe('visitAtiyatTotals', () => {
  it('excluded category (tameer) counts in wusooli but not in reward; GSB counts in both', () => {
    expect(visitAtiyatTotals(smokeAtiyat, categories)).toEqual({
      niyyat: 25000,
      wusooli: 7500,
      rewardWusooli: 6500,
      gsbBoxes: 2,
      gsbAmount: 2000,
    });
  });

  it('niyyat never counts in wusooli', () => {
    const onlyNiyyat = {
      entries: [
        { type: 'niyyat' as const, category: 'mahana', kind: 'naqd' as const, amount: 5000 },
      ],
    };
    expect(visitAtiyatTotals(onlyNiyyat, categories)).toMatchObject({
      niyyat: 5000,
      wusooli: 0,
      rewardWusooli: 0,
    });
  });

  it('an unknown category is never reward-included', () => {
    const odd = {
      entries: [{ type: 'wusooli' as const, category: 'zzz', kind: 'naqd' as const, amount: 700 }],
    };
    expect(visitAtiyatTotals(odd, categories)).toMatchObject({ wusooli: 700, rewardWusooli: 0 });
  });
});

describe('computeDayTotals', () => {
  const day: JadwalInput = {
    travel: { mode: 'bike', meterStart: 48214, meterEnd: 48276 },
    visits: [
      {
        donors: { oldMet: 4, newDonors: [{ name: 'a' }] },
        atiyat: smokeAtiyat,
        ijtima: { held: true, participants: 18 },
        mashwara: { held: true, participants: 3 },
      },
      {
        donors: { oldMet: 2, newDonors: [{ name: 'b' }, { name: 'c' }] },
        atiyat: { entries: [{ type: 'wusooli', category: 'deg', kind: 'naqd', amount: 500 }] },
        ijtima: { held: false },
        mashwara: { held: false },
      },
    ],
  };

  it('adds up every visit and the bike km', () => {
    expect(computeDayTotals(day, categories)).toEqual({
      villages: 2,
      oldDonors: 6,
      newDonors: 3,
      niyyat: 25000,
      wusooli: 8000,
      rewardWusooli: 6500,
      excludedWusooli: 1500,
      gsbBoxes: 2,
      gsbAmount: 2000,
      ijtimas: 1,
      ijtimaParticipants: 18,
      mashwaras: 1,
      km: 62,
      fare: 0,
    });
  });

  it('uses the fare for bus days and zeros for a day without visits', () => {
    expect(
      computeDayTotals({ travel: { mode: 'bus', fare: 350 }, visits: [] }, categories),
    ).toMatchObject({
      villages: 0,
      wusooli: 0,
      km: 0,
      fare: 350,
    });
  });
});

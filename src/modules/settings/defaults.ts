// Seed defaults for the `settings` document (scope §3.3, §3.5, §4; data model `settings`).
// Runtime code reads the database document via getSettings(); only the seed uses this file.

import { DEFAULT_DONOR_TASKS, DEFAULT_OTHER_WORK } from './donor-tasks.js';

export const DEFAULT_SETTINGS = {
  _id: 'app',
  backdateDays: 3,
  maxKmPerDay: 400,
  weekStartsOn: 1,
  atiyatCategories: [
    { id: 'ushr', labelUr: 'فصلوں کا عشر', labelRoman: 'Fasal ka Ushr', rewardIncluded: true },
    { id: 'mahana', labelUr: 'ماہانہ عطیات', labelRoman: 'Mahana atiyat', rewardIncluded: true },
    {
      id: 'madrasa',
      labelUr: 'مدرسہ / جامعہ کچن',
      labelRoman: 'Madrasa / Jamia kitchen',
      rewardIncluded: true,
    },
    {
      id: 'langar',
      labelUr: 'لنگرِ رضویہ (فیضانِ مدینہ)',
      labelRoman: 'Langar-e-Razvia',
      rewardIncluded: true,
    },
    { id: 'ramzan', labelUr: 'رمضان عطیات', labelRoman: 'Ramzan atiyat', rewardIncluded: true },
    { id: 'telethon', labelUr: 'ٹیلی تھون', labelRoman: 'Telethon', rewardIncluded: true },
    {
      id: 'janwar',
      labelUr: 'جانور / گوشت (بکرا، دنبہ، کٹا یا ان کا گوشت)',
      labelRoman: 'Janwar / gosht',
      rewardIncluded: true,
    },
    {
      id: 'deegar',
      labelUr: 'دیگر نقد / مٹیریل',
      labelRoman: 'Deegar naqd / material',
      rewardIncluded: true,
    },
    {
      id: 'gsb',
      labelUr: 'گھریلو صدقہ بکس',
      labelRoman: 'Gharelu Sadqa Box (GSB)',
      rewardIncluded: true,
    },
    { id: 'tameer', labelUr: 'تعمیرات', labelRoman: 'Tameerat', rewardIncluded: false },
    { id: 'fgrf', labelUr: 'FGRF / ویلفیئر', labelRoman: 'FGRF / Welfare', rewardIncluded: false },
    {
      id: 'deg',
      labelUr: 'بریانی / سالن / دیگ',
      labelRoman: 'Biryani / salan / deg',
      rewardIncluded: false,
    },
  ].map((c, i) => ({ ...c, order: i + 1 })),
  reward: {
    periods: [
      { id: 'H1', startMonth: 12, months: 6 },
      { id: 'H2', startMonth: 6, months: 6 },
    ],
    divisor: 6,
    tiers: [
      { minAvg: 300_000, amount: 10_000 },
      { minAvg: 200_000, amount: 5_000 },
    ],
    nearPct: 0.85,
  },
  targets: { newDonorsPerOutdoorDay: 2, ijtimaPerMonth: 1, mashwaraPerMonth: 1 },
  donorTasks: DEFAULT_DONOR_TASKS,
  otherWork: DEFAULT_OTHER_WORK,
};

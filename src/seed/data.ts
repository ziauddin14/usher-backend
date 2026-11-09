// Invented demo data only — no real people, ajeer codes or phone numbers (CLAUDE.md rule 11).
import type { UnitLevel } from '../models/unit.js';
import type { Role, Zimmedari } from '../models/user.js';

export interface SeedUnit {
  code: string;
  name: string;
  nameUr: string;
  level: UnitLevel;
  parentCode: string | null;
}

type District = [code: string, name: string, nameUr: string];

const SINDH_DIVISIONS: [code: string, name: string, nameUr: string, districts: District[]][] = [
  [
    'BHANBHORE',
    'Bhanbhore',
    'بھنبھور',
    [
      ['BADIN', 'Badin', 'بدین'],
      ['SAJAWAL', 'Sajawal', 'سجاول'],
      ['THATTA', 'Thatta', 'ٹھٹھہ'],
    ],
  ],
  [
    'HYDERABAD',
    'Hyderabad',
    'حیدرآباد',
    [
      ['HYDERABAD_DIST', 'Hyderabad', 'حیدرآباد'],
      ['TANDO_ALLAHYAR', 'Tando Allahyar', 'ٹنڈو الہ یار'],
      ['TANDO_MUHAMMAD_KHAN', 'Tando Muhammad Khan', 'ٹنڈو محمد خان'],
    ],
  ],
  [
    'JACOBABAD',
    'Jacobabad',
    'جیکب آباد',
    [
      ['JACOBABAD_DIST', 'Jacobabad', 'جیکب آباد'],
      ['KASHMORE', 'Kashmore', 'کشمور'],
      ['SHIKARPUR', 'Shikarpur', 'شکارپور'],
    ],
  ],
  [
    'LARKANA',
    'Larkana',
    'لاڑکانہ',
    [
      ['LARKANA_DIST', 'Larkana', 'لاڑکانہ'],
      ['DADU', 'Dadu', 'دادو'],
    ],
  ],
  [
    'MIRPUR_KHAS',
    'Mirpur Khas',
    'میرپور خاص',
    [
      ['MIRPUR_KHAS_DIST', 'Mirpur Khas', 'میرپور خاص'],
      ['THARPARKAR', 'Tharparkar', 'تھرپارکر'],
      ['UMERKOT', 'Umerkot', 'عمرکوٹ'],
    ],
  ],
  [
    'NAWAB_SHAH',
    'Nawab Shah',
    'نوابشاہ',
    [
      ['SANGHAR', 'Sanghar', 'سانگھڑ'],
      ['NAUSHAHRO_FEROZE', 'Naushahro Feroze', 'نوشہرو فیروز'],
      ['SHAHEED_BENAZIRABAD', 'Shaheed Benazirabad', 'شہید بینظیر آباد'],
    ],
  ],
  [
    'SUKKUR',
    'Sukkur',
    'سکھر',
    [
      ['GHOTKI', 'Ghotki', 'گھوٹکی'],
      ['SUKKUR_DIST', 'Sukkur', 'سکھر'],
      ['KHAIRPUR', 'Khairpur', 'خیرپور'],
    ],
  ],
];

/**
 * Demo Tehsil (Phase 2, invented): Khairpur's Ushar Zimmedaran sit under one Tehsil / Town, with
 * a Tehsil Zimmedar login. Every other district keeps its zimmedaran on the district itself.
 */
export const DEMO_TEHSIL = { code: 'KHAIRPUR_TOWN', district: 'KHAIRPUR' } as const;

/**
 * Pakistan → Suba → Division → District (→ the one demo Tehsil). Division and district can share a
 * name; district codes then end in `_DIST`.
 */
export function seedUnits(): SeedUnit[] {
  const units: SeedUnit[] = [
    { code: 'PK', name: 'Pakistan', nameUr: 'پاکستان', level: 'pakistan', parentCode: null },
    {
      code: 'INT_SINDH',
      name: 'Interior Sindh',
      nameUr: 'اندرون سندھ',
      level: 'suba',
      parentCode: 'PK',
    },
    { code: 'PUNJAB', name: 'Punjab', nameUr: 'پنجاب', level: 'suba', parentCode: 'PK' },
    { code: 'GUJRAT', name: 'Gujrat', nameUr: 'گجرات', level: 'division', parentCode: 'PUNJAB' },
    {
      code: 'GUJRAT_DIST',
      name: 'Gujrat',
      nameUr: 'گجرات',
      level: 'district',
      parentCode: 'GUJRAT',
    },
  ];
  for (const [code, name, nameUr, districts] of SINDH_DIVISIONS) {
    units.push({ code, name, nameUr, level: 'division', parentCode: 'INT_SINDH' });
    for (const [dCode, dName, dNameUr] of districts) {
      units.push({
        code: dCode,
        name: dName,
        nameUr: dNameUr,
        level: 'district',
        parentCode: code,
      });
    }
  }
  units.push({
    code: DEMO_TEHSIL.code,
    name: 'Khairpur Town',
    nameUr: 'خیرپور ٹاؤن',
    level: 'tehsil',
    parentCode: DEMO_TEHSIL.district,
  });
  return units;
}

export interface SeedUser {
  ajeerCode: string;
  name: string;
  nameUr: string;
  role: Role;
  zimmedari?: Zimmedari;
  unitCode: string;
}

/** The five demo logins (scope §6) and the demo Tehsil Zimmedar (Phase 2). */
export const DEMO_USERS: SeedUser[] = [
  {
    ajeerCode: '9010001',
    name: 'Muhammad Saleem',
    nameUr: 'محمد سلیم',
    role: 'pakistan',
    unitCode: 'PK',
  },
  {
    ajeerCode: '9020001',
    name: 'Abdul Qadir',
    nameUr: 'عبد القادر',
    role: 'suba',
    unitCode: 'INT_SINDH',
  },
  {
    ajeerCode: '9030001',
    name: 'Ghulam Mustafa',
    nameUr: 'غلام مصطفیٰ',
    role: 'division',
    unitCode: 'SUKKUR',
  },
  {
    ajeerCode: '9040001',
    name: 'Abdul Rashid',
    nameUr: 'عبد الرشید',
    role: 'district',
    unitCode: 'GHOTKI',
  },
  {
    ajeerCode: '9090412',
    name: 'Muhammad Arif',
    nameUr: 'محمد عارف',
    role: 'zimmedar',
    zimmedari: 'ushar',
    unitCode: 'GHOTKI',
  },
  {
    ajeerCode: '9050001',
    name: 'Muhammad Naeem',
    nameUr: 'محمد نعیم',
    role: 'tehsil',
    unitCode: DEMO_TEHSIL.code,
  },
];

export const DEMO_PASSWORD = 'demo1234';

export const FIRST: [string, string][] = [
  ['Ahmed', 'احمد'],
  ['Ali', 'علی'],
  ['Bilal', 'بلال'],
  ['Usman', 'عثمان'],
  ['Hamza', 'حمزہ'],
  ['Imran', 'عمران'],
  ['Zubair', 'زبیر'],
  ['Faisal', 'فیصل'],
  ['Asif', 'آصف'],
  ['Nadeem', 'ندیم'],
  ['Shahid', 'شاہد'],
  ['Rizwan', 'رضوان'],
  ['Kashif', 'کاشف'],
  ['Tariq', 'طارق'],
  ['Waseem', 'وسیم'],
  ['Naveed', 'نوید'],
  ['Sajid', 'ساجد'],
  ['Javed', 'جاوید'],
  ['Irfan', 'عرفان'],
  ['Saeed', 'سعید'],
];
export const LAST: [string, string][] = [
  ['Raza', 'رضا'],
  ['Hussain', 'حسین'],
  ['Iqbal', 'اقبال'],
  ['Akhtar', 'اختر'],
  ['Rasheed', 'رشید'],
  ['Hanif', 'حنیف'],
  ['Latif', 'لطیف'],
  ['Sabir', 'صابر'],
  ['Jamil', 'جمیل'],
  ['Nawaz', 'نواز'],
  ['Shafiq', 'شفیق'],
  ['Majeed', 'مجید'],
];

const VILLAGE_NAMES = [
  'رحیم آباد',
  'کریم بخش',
  'اللہ ڈنو',
  'نور محمد',
  'حاجی خان',
  'میرپور',
  'شاہ پور',
  'قادر آباد',
  'فتح پور',
  'سلطان آباد',
  'دین پور',
  'بشیر آباد',
  'غلام نبی',
  'احمد پور',
  'جمال پور',
  'محمد پور',
  'نصیر آباد',
  'رحمت پور',
  'علی آباد',
  'حسن پور',
  'یار محمد',
  'خیر محمد',
  'مولا بخش',
  'شیر خان',
];

/** Small deterministic PRNG so every seed run produces the same demo data. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ~60 invented zimmedaran: 10 in Ghotki (incl. demo 9090412), 2–4 in every other district. */
export function seedZimmedaran(districtCodes: string[]): SeedUser[] {
  const rand = rng(2026);
  const users: SeedUser[] = [];
  let next = 9000001;
  for (const unitCode of districtCodes) {
    const count = unitCode === 'GHOTKI' ? 9 : 2 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i += 1) {
      const [fr, fu] = FIRST[Math.floor(rand() * FIRST.length)]!;
      const [lr, lu] = LAST[Math.floor(rand() * LAST.length)]!;
      const n = users.length;
      const zimmedari: Zimmedari = n % 9 === 8 ? 'event' : n % 5 === 4 ? 'tehsil_town' : 'ushar';
      users.push({
        ajeerCode: String(next++),
        name: `${fr} ${lr}`,
        nameUr: `${fu} ${lu}`,
        role: 'zimmedar',
        zimmedari,
        unitCode: unitCode === DEMO_TEHSIL.district ? DEMO_TEHSIL.code : unitCode,
      });
    }
  }
  return users;
}

/** 8–15 invented Urdu village names per district. */
export function seedVillageNames(districtCode: string, index: number): string[] {
  const rand = rng(1000 + index);
  const count = districtCode === 'GHOTKI' ? 15 : 8 + Math.floor(rand() * 8);
  const pool = [...VILLAGE_NAMES];
  const names: string[] = [];
  while (names.length < count && pool.length > 0) {
    const [name] = pool.splice(Math.floor(rand() * pool.length), 1);
    names.push(`گوٹھ ${name!}`);
  }
  return names;
}

// Tasks of a meeting with a donor (CTO 12 Nov 2026, Usher management list "عشر ذمہ دار کے
// جدول/ملاقات کے کام/مقاصد", multi-select). Seed default of settings.donorTasks; the live settings
// document may override it (getSettings falls back to this list while it has none).
//  - count: ticking it asks a number (toray / gattu: how many bags).
//  - parts: ticking it asks which parts (at least one).
//  - dayTask: also offered as the day's "other work", for a day without any Gaon.

export interface DonorTaskDef {
  id: string;
  labelUr: string;
  labelRoman: string;
  order: number;
  count?: { labelUr: string; labelRoman: string };
  parts?: { id: string; labelUr: string; labelRoman: string }[];
  dayTask?: boolean;
}

export const DEFAULT_DONOR_TASKS: DonorTaskDef[] = [
  {
    id: 'deeni_dawat',
    labelUr: 'دینی کام کی دعوت (ہفتہ وار اجتماع / مدنی مذاکرہ، قافلہ وغیرہ)',
    labelRoman: 'Deeni kaam ki dawat (haftawar ijtima / madani muzakra, qafila waghaira)',
  },
  { id: 'kisan_ijtima', labelUr: 'کسان اجتماع کی دعوت', labelRoman: 'Kisan ijtima ki dawat' },
  {
    id: 'karachi_ijtima',
    labelUr: 'کراچی تربیتی اجتماع کی دعوت',
    labelRoman: 'Karachi tarbiyati ijtima ki dawat',
  },
  {
    id: 'tarbiyati_halqa',
    labelUr: 'زمینداروں کے تربیتی حلقے کی دعوت',
    labelRoman: 'Zamindaron ke tarbiyati halqe ki dawat',
  },
  {
    id: 'madani_markaz',
    labelUr: 'مدنی مراکز کے وزٹ کی دعوت',
    labelRoman: 'Madani marakiz ke visit ki dawat',
  },
  {
    id: 'gsb',
    labelUr: 'گھریلو صدقہ بکس رکھنا / کھولنا',
    labelRoman: 'Gharelu sadqa box rakhna / kholna',
  },
  {
    id: 'toray',
    labelUr: 'توڑے / گٹو کی تقسیم',
    labelRoman: 'Toray / gattu ki taqseem',
    count: { labelUr: 'کتنی بوریاں دیں', labelRoman: 'Kitni boriyan di' },
  },
  { id: 'wusooli', labelUr: 'عطیات / عشر وصولی', labelRoman: 'Atiyat / ushr wusooli' },
  {
    id: 'sharai_heela',
    labelUr: 'شرعی حیلہ / جنس منتقلی / فروخت',
    labelRoman: 'Sharai heela / jins muntaqili / farokht',
    parts: [
      { id: 'heela', labelUr: 'شرعی حیلہ', labelRoman: 'Sharai heela' },
      { id: 'muntaqili', labelUr: 'جنس منتقلی', labelRoman: 'Jins muntaqili' },
      { id: 'farokht', labelUr: 'فروخت', labelRoman: 'Farokht' },
    ],
    dayTask: true,
  },
  {
    id: 'janwar',
    labelUr: 'جانور (نیت کروانا / وصولی / فروخت)',
    labelRoman: 'Janwar (niyyat karwana / wusooli / farokht)',
    parts: [
      { id: 'niyyat', labelUr: 'نیت کروانا', labelRoman: 'Niyyat karwana' },
      { id: 'wusooli', labelUr: 'وصولی', labelRoman: 'Wusooli' },
      { id: 'farokht', labelUr: 'فروخت', labelRoman: 'Farokht' },
    ],
    dayTask: true,
  },
].map((t, i) => ({ ...t, order: i + 1 }));

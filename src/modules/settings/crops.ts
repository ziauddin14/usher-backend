// Crops of a Gaon (CTO 17 Nov 2026, list from the CTO the same day): a multi-select on the Gaon's
// information. "other" asks for the crop's name (village.cropsOther). Seed default of
// settings.crops — the live settings document may hold its own list (getCrops falls back to this).

export interface CropDef {
  id: string;
  labelUr: string;
  labelRoman: string;
  order: number;
}

/** The crop that asks for a name. */
export const OTHER_CROP = 'other';

export const DEFAULT_CROPS: CropDef[] = [
  { id: 'gandum', labelUr: 'گندم', labelRoman: 'Gandum' },
  { id: 'dhaan', labelUr: 'دھان / منجی', labelRoman: 'Dhaan / Munji' },
  { id: 'makai', labelUr: 'مکئی', labelRoman: 'Makai' },
  { id: 'kapas', labelUr: 'کپاس', labelRoman: 'Kapas' },
  { id: 'ganna', labelUr: 'گنا', labelRoman: 'Ganna' },
  { id: 'moongphali', labelUr: 'مونگ پھلی', labelRoman: 'Moong phali' },
  { id: 'aam', labelUr: 'آم', labelRoman: 'Aam' },
  { id: 'kinno', labelUr: 'کنوں / مالٹا', labelRoman: 'Kinno / Malta' },
  { id: 'khajoor', labelUr: 'کھجور', labelRoman: 'Khajoor' },
  { id: 'piyaz', labelUr: 'پیاز', labelRoman: 'Piyaz' },
  { id: 'aalu', labelUr: 'آلو', labelRoman: 'Aalu' },
  { id: 'tamatar', labelUr: 'ٹماٹر', labelRoman: 'Tamatar' },
  { id: 'kela', labelUr: 'کیلا', labelRoman: 'Kela' },
  { id: OTHER_CROP, labelUr: 'دیگر', labelRoman: 'Digar' },
].map((c, i) => ({ ...c, order: i + 1 }));

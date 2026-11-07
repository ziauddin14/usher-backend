/**
 * Normalized village name for de-duplication and search (data model `villages.nameKey`):
 * trim, collapse spaces, drop a leading "گوٹھ"/"goth", unify Arabic/Urdu letter variants,
 * lower-case Latin.
 */
export function villageNameKey(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ه/g, 'ہ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(گوٹھ|goth)\s+/i, '')
    .toLowerCase();
}

/**
 * A looser key for spotting likely duplicates (never for uniqueness): villageNameKey, then no
 * spaces or punctuation, no diacritics or tatweel, and common Urdu letter variants unified
 * (ے/ی, ۃ/ہ, ھ/ہ, أ/إ/آ/ا, ؤ/و, ئ/ی).
 */
export function looseVillageKey(name: string): string {
  return villageNameKey(name)
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[ےۓئ]/g, 'ی')
    .replace(/[ۃةھ]/g, 'ہ')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

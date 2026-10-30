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

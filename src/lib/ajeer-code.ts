/**
 * Ajeer code as typed at login: digits only. The department export writes it as
 * "<code>/<n>" (e.g. "12345/1"); the part before "/" is the code used everywhere else
 * (village list `ID`), so that is what we store. Urdu digits are converted.
 */
export function normalizeAjeerCode(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\s/g, '');
  const code = text.split('/')[0] ?? '';
  return /^\d{3,9}$/.test(code) ? code : null;
}

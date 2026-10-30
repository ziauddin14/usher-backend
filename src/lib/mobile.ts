/**
 * Pakistani mobile number → `03XXXXXXXXX`, or null when it is not one.
 * Accepts spaces, dashes, "+92", "92", "0092" and a missing leading 0.
 */
export function normalizeMobile(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  let digits = String(input).replace(/\D/g, '');
  if (digits.startsWith('0092')) digits = digits.slice(4);
  else if (digits.startsWith('92') && digits.length === 12) digits = digits.slice(2);
  if (digits.length === 10 && digits.startsWith('3')) digits = `0${digits}`;
  return /^03\d{9}$/.test(digits) ? digits : null;
}

/** For screens and logs: "0300•••4567" (never show or log the full number to others). */
export function maskMobile(mobile: string | null | undefined): string | null {
  if (!mobile) return null;
  return `${mobile.slice(0, 4)}•••${mobile.slice(-4)}`;
}

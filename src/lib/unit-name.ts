import { headerKey } from './xlsx.js';

/** Words that only say which level a unit is ("Multan Division", "ڈسٹرکٹ لودھراں"). */
export const LEVEL_WORDS =
  /(^|\s)(suba|province|division|div|district|dist|zila|tehsil|town|صوبہ|ڈویژن|ڈسٹرکٹ|ضلع|تحصیل|ٹاؤن)(?=\s|$)/gi;

/** Comparison key for unit names: level words, case, spaces and punctuation ignored. */
export const unitKey = (name: string) => headerKey(name.replace(LEVEL_WORDS, ' '));

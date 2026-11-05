// Roman ↔ Urdu names of subas, divisions and districts (backend/data/district-names.csv).
// The employee list writes units in Urdu, the village list writes districts in Roman; this file
// connects them. It holds place names only, so it is committed (CTO, 31 Oct 2026).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { UnitLevel } from '../models/unit.js';
import { unitKey } from './unit-name.js';

export const DISTRICT_NAMES_FILE = fileURLToPath(
  new URL('../../data/district-names.csv', import.meta.url),
);

export interface DistrictNameRow {
  subaUr: string;
  subaRoman: string;
  divisionUr: string;
  divisionRoman: string;
  districtUr: string;
  districtRoman: string;
  /** Spellings used in the village list for this district. */
  villageFileNames: string[];
}

/** Urdu unit chain a village-list district spelling points to. */
export interface DistrictChain {
  subaUr: string;
  divisionUr: string;
  districtUr: string;
}

/** Minimal CSV: commas, double-quoted fields with "" escapes, BOM, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, ''); // strip a UTF-8 byte-order mark
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

export function readDistrictNames(file = DISTRICT_NAMES_FILE): DistrictNameRow[] {
  const [header, ...rows] = parseCsv(readFileSync(file, 'utf8'));
  const col = (name: string) => {
    const i = header?.indexOf(name) ?? -1;
    if (i < 0) throw new Error(`${file}: column "${name}" missing`);
    return i;
  };
  const c = {
    subaUr: col('suba_ur'),
    subaRoman: col('suba_roman'),
    divisionUr: col('division_ur'),
    divisionRoman: col('division_roman'),
    districtUr: col('district_ur'),
    districtRoman: col('district_roman'),
    village: col('village_file_names'),
  };
  return rows.map((r) => {
    const get = (i: number) => (r[i] ?? '').trim();
    return {
      subaUr: get(c.subaUr),
      subaRoman: get(c.subaRoman),
      divisionUr: get(c.divisionUr),
      divisionRoman: get(c.divisionRoman),
      districtUr: get(c.districtUr),
      districtRoman: get(c.districtRoman),
      villageFileNames: get(c.village)
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
    };
  });
}

const chainKey = (...names: string[]) => names.map(unitKey).join('|');

/** Lookups built from the mapping file. */
export class DistrictNames {
  private roman = new Map<string, string>();
  private villageNames = new Map<string, DistrictChain>();

  constructor(rows: DistrictNameRow[]) {
    for (const r of rows) {
      if (r.subaUr && r.subaRoman) this.roman.set(`suba:${chainKey(r.subaUr)}`, r.subaRoman);
      if (r.subaUr && r.divisionUr && r.divisionRoman) {
        this.roman.set(`division:${chainKey(r.subaUr, r.divisionUr)}`, r.divisionRoman);
      }
      if (r.subaUr && r.divisionUr && r.districtUr && r.districtRoman) {
        this.roman.set(
          `district:${chainKey(r.subaUr, r.divisionUr, r.districtUr)}`,
          r.districtRoman,
        );
        for (const v of r.villageFileNames) {
          this.villageNames.set(unitKey(v), {
            subaUr: r.subaUr,
            divisionUr: r.divisionUr,
            districtUr: r.districtUr,
          });
        }
      }
    }
  }

  static load(file?: string): DistrictNames {
    return new DistrictNames(readDistrictNames(file));
  }

  /** Roman name of an Urdu unit, given its Urdu ancestors (suba first). */
  romanFor(level: UnitLevel, urduChain: string[]): string | undefined {
    return this.roman.get(`${level}:${chainKey(...urduChain)}`);
  }

  /** The district a village-list spelling ("District Bahawalnager") stands for. */
  forVillageFileName(text: string): DistrictChain | undefined {
    return this.villageNames.get(unitKey(text));
  }
}

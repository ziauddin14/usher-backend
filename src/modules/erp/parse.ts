// Reading the daily E-Raseed (ERP) file (CTO 11 Nov 2026): CSV or .xlsx → checked receipt lines.
// Pure functions — no database. The format is documented in the README ("ERP receipts upload").
import type ExcelJS from 'exceljs';
import { normalizeAjeerCode } from '../../lib/ajeer-code.js';
import { isDateString } from '../../lib/time.js';
import { headerKey, loadWorkbookBuffer } from '../../lib/xlsx.js';

export const MAX_ERP_ROWS = 20_000;

/**
 * Column → accepted header texts (compared with headerKey: lower-case, letters and digits), best
 * first. Both the short UsherDesk format and the E-Raseed "General" export (Cash and Material
 * files, sample of 11 Nov 2026) are read: e.g. "User Login ID" = "ush" + Ajeer Code, "Donation
 * Mode" = Cash / Material, "Amount In Base Currency", "Purpose Name" = mad, "Active / Cancel".
 */
export const ERP_COLUMNS = {
  receiptNo: ['receiptno', 'receiptnumber', 'raseedno', 'raseed', 'receipt'],
  lineNo: ['lineno', 'line', 'linenumber'],
  // Usher management (CTO 12 Nov 2026): reports go by the E-Raseed "Initial Receipt Date".
  date: ['initialreceiptdate', 'receiptdate', 'date', 'raseeddate'],
  ajeerCode: ['ajeercode', 'userloginid', 'ajeer', 'code'],
  type: ['attiyattype', 'atiyattype', 'donationmode', 'type', 'kind'],
  amount: ['amountrs', 'amountinbasecurrency', 'amount', 'raqam'],
  mad: ['mad', 'purposename', 'category', 'head'],
  item: ['jinsitem', 'materialitem', 'item', 'material'],
  qty: ['jinsqty', 'weightqty', 'qty', 'quantity'],
  qtyUnit: ['jinsunit', 'qtyunit', 'unit'],
  status: ['status', 'activecancel'],
  /** The donor's name (CTO 13 Nov 2026: details per donor); never the donor's mobile. */
  donor: ['donorname', 'donor', 'نامڈونر'],
  /** E-Raseed extras kept for later reports (Wajiba / Nafila; deposited or not). */
  fund: ['fundcategory'],
  deposit: ['depositundeposit'],
} as const;
export type ErpColumn = keyof typeof ERP_COLUMNS;

const REQUIRED: ErpColumn[] = ['receiptNo', 'date', 'ajeerCode', 'type', 'amount'];

export type ErpRowReason =
  | 'RECEIPT_NO_MISSING'
  | 'LINE_NO_INVALID'
  | 'DUPLICATE_IN_FILE'
  | 'DATE_INVALID'
  | 'DATE_IN_FUTURE'
  | 'AJEER_CODE_INVALID'
  | 'AJEER_CODE_UNKNOWN'
  | 'TYPE_INVALID'
  | 'AMOUNT_INVALID'
  | 'JINS_ITEM_MISSING'
  | 'QTY_INVALID'
  | 'STATUS_INVALID';

export interface ErpRowError {
  /** Row number in the file (1 = header row). */
  row: number;
  reason: ErpRowReason;
}

export interface ErpLine {
  row: number;
  receiptNo: string;
  lineNo: number;
  date: string;
  ajeerCode: string;
  kind: 'naqd' | 'jins';
  amount: number;
  mad?: string;
  donorName?: string;
  item?: string;
  qty?: number;
  qtyUnit?: string;
  cancelled: boolean;
  fund?: string;
  /** E-Raseed "Deposit / Undeposit": true = DEPOSITED, false = UNDEPOSIT, absent = not given. */
  deposited?: boolean;
}

export type ErpFileProblem = 'EMPTY' | 'NO_HEADER' | 'TOO_MANY_ROWS' | 'UNREADABLE';

export class ErpFileError extends Error {
  constructor(
    readonly problem: ErpFileProblem,
    readonly missing: ErpColumn[] = [],
  ) {
    super(problem);
    this.name = 'ErpFileError';
  }
}

// ---- Reading the file into a table of texts ----

/** RFC 4180 CSV (quotes, "" escapes, CRLF), delimiter guessed from the first line (, ; or tab). */
export function parseCsv(text: string): string[][] {
  const bom = String.fromCharCode(0xfeff);
  const body = text.startsWith(bom) ? text.slice(1) : text;
  const firstLine = body.slice(0, body.search(/\r?\n|$/));
  const delimiter = [',', ';', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim()));
}

/** Text of an Excel cell; a real date cell becomes YYYY-MM-DD (Excel dates carry no time zone). */
function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return cell.text.trim();
}

/** First worksheet with content → table of texts. */
export async function xlsxTable(bytes: Buffer): Promise<string[][]> {
  const workbook = await loadWorkbookBuffer(bytes);
  for (const sheet of workbook.worksheets) {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: true }, (excelRow, rowNumber) => {
      const cells: string[] = [];
      excelRow.eachCell({ includeEmpty: true }, (cell, col) => {
        cells[col - 1] = cellText(cell);
      });
      rows[rowNumber - 1] = Array.from(cells, (c) => c ?? '');
    });
    const table = Array.from(rows, (r) => r ?? []);
    if (table.some((r) => r.some((c) => c !== ''))) return table;
  }
  return [];
}

/** The uploaded bytes → table: .xlsx when the bytes are a zip (PK), CSV (UTF-8) otherwise. */
export async function readErpTable(bytes: Buffer): Promise<string[][]> {
  if (bytes.length === 0) throw new ErpFileError('EMPTY');
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    try {
      return await xlsxTable(bytes);
    } catch {
      throw new ErpFileError('UNREADABLE');
    }
  }
  return parseCsv(bytes.toString('utf8'));
}

// ---- Checking each row ----

const toWesternDigits = (s: string) =>
  s
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

/** YYYY-MM-DD (time after it ignored), or D/M/YYYY and D-M-YYYY (day first, as in Pakistan). */
export function erpDate(raw: string): string | null {
  const s = toWesternDigits(raw).trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(s);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s.*)?$/.exec(s);
  const [y, m, d] = iso
    ? [iso[1]!, iso[2]!, iso[3]!]
    : dmy
      ? [dmy[3]!, dmy[2]!, dmy[1]!]
      : [null, null, null];
  if (!y) return null;
  const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isDateString(date) ? date : null;
}

/**
 * Rupees as a whole number: "5,000", "Rs 5000", "5000.00" → 5000. The E-Raseed export writes some
 * material values with floating-point noise ("2999.9999999999995"), so a fraction is rounded to the
 * nearest rupee (money is stored as integer rupees). A sign or text → null.
 */
export function erpAmount(raw: string): number | null {
  const s = toWesternDigits(raw)
    .replace(/rs\.?|pkr|,|\s/gi, '')
    .trim();
  return /^\d{1,12}(?:\.\d+)?$/.test(s) ? Math.round(Number(s)) : null;
}

/** The ERP writes a missing value as the two characters backslash + "N" (MySQL NULL). */
const ERP_NULL = `${String.fromCharCode(92)}N`;

/** "ush76680" (E-Raseed login ID) or "76680/2" → the Ajeer Code; anything else → null. */
export function erpAjeerCode(raw: string | undefined): string | null {
  return normalizeAjeerCode(raw?.trim().replace(/^[a-z]+/i, ''));
}

function erpKind(raw: string): 'naqd' | 'jins' | null {
  const k = headerKey(raw);
  if (['naqad', 'naqd', 'cash', 'نقد'].includes(k)) return 'naqd';
  if (['jins', 'kind', 'material', 'inkind', 'جنس'].includes(k)) return 'jins';
  return null;
}

function erpCancelled(raw: string | undefined): boolean | null {
  const k = headerKey(raw ?? '');
  if (k === '' || k === 'active') return false;
  if (['cancelled', 'canceled', 'cancel', 'void', 'reversed'].includes(k)) return true;
  return null;
}

/**
 * Header row = the first row that has every required column; rows above it are titles. When two
 * headers fit one column ("Amount" and "Amount In Base Currency"), the better-listed name wins.
 */
function findHeader(table: string[][]): { at: number; columns: Map<number, ErpColumn> } {
  let best: ErpColumn[] = [];
  for (let at = 0; at < Math.min(table.length, 20); at += 1) {
    const pick = new Map<ErpColumn, { col: number; rank: number }>();
    table[at]!.forEach((text, col) => {
      const k = headerKey(text);
      for (const c of Object.keys(ERP_COLUMNS) as ErpColumn[]) {
        const rank = (ERP_COLUMNS[c] as readonly string[]).indexOf(k);
        const prev = pick.get(c);
        if (rank >= 0 && (!prev || rank < prev.rank)) pick.set(c, { col, rank });
      }
    });
    const columns = new Map<number, ErpColumn>();
    for (const [c, { col }] of pick) if (!columns.has(col)) columns.set(col, c);
    const found = [...columns.values()];
    if (REQUIRED.every((c) => found.includes(c))) return { at, columns };
    if (found.length > best.length) best = found;
  }
  throw new ErpFileError(
    'NO_HEADER',
    REQUIRED.filter((c) => !best.includes(c)),
  );
}

/**
 * Table → checked lines and row errors. `today` = Karachi date (no receipt from the future).
 * A row with an error is not saved; every other row is.
 */
export function checkErpRows(
  table: string[][],
  today: string,
): {
  lines: ErpLine[];
  errors: ErpRowError[];
  rows: number;
  /** Highest line number of each receipt in the file (a saved line above it was removed). */
  receiptLines: Map<string, number>;
} {
  const { at, columns } = findHeader(table);
  const dataRows = table
    .slice(at + 1)
    .map((cells, i) => ({ row: at + 2 + i, cells }))
    .filter((r) => r.cells.some((c) => c !== ''));
  if (dataRows.length === 0) throw new ErpFileError('EMPTY');
  if (dataRows.length > MAX_ERP_ROWS) throw new ErpFileError('TOO_MANY_ROWS');

  const lines: ErpLine[] = [];
  const errors: ErpRowError[] = [];
  const seen = new Set<string>();
  // Without a line_no column (the E-Raseed export), a receipt's rows are its lines 1, 2, … in file
  // order (one receipt can hold several mad or material items).
  const hasLineNo = [...columns.values()].includes('lineNo');
  const linesOf = new Map<string, number>();
  const receiptLines = new Map<string, number>();
  for (const { row, cells } of dataRows) {
    const v: Partial<Record<ErpColumn, string>> = {};
    for (const [col, column] of columns) {
      const text = cells[col]?.trim();
      if (text && text !== ERP_NULL) v[column] = text;
    }
    const fail = (reason: ErpRowReason) => errors.push({ row, reason });

    const receiptNo = v.receiptNo?.replace(/\s+/g, ' ');
    if (!receiptNo) {
      fail('RECEIPT_NO_MISSING');
      continue;
    }
    const nth = (linesOf.get(receiptNo) ?? 0) + 1;
    linesOf.set(receiptNo, nth);
    const lineNo = !hasLineNo
      ? nth
      : v.lineNo === undefined
        ? 1
        : Number(toWesternDigits(v.lineNo));
    if (!Number.isInteger(lineNo) || lineNo < 1) {
      fail('LINE_NO_INVALID');
      continue;
    }
    receiptLines.set(receiptNo, Math.max(receiptLines.get(receiptNo) ?? 0, lineNo));
    const key = `${receiptNo}\u0000${lineNo}`;
    if (seen.has(key)) {
      fail('DUPLICATE_IN_FILE');
      continue;
    }
    seen.add(key);
    const date = erpDate(v.date ?? '');
    if (!date) {
      fail('DATE_INVALID');
      continue;
    }
    if (date > today) {
      fail('DATE_IN_FUTURE');
      continue;
    }
    const ajeerCode = erpAjeerCode(v.ajeerCode);
    if (!ajeerCode) {
      fail('AJEER_CODE_INVALID');
      continue;
    }
    const kind = erpKind(v.type ?? '');
    if (!kind) {
      fail('TYPE_INVALID');
      continue;
    }
    const amount = erpAmount(v.amount ?? '');
    if (amount === null || (kind === 'naqd' && amount === 0)) {
      fail('AMOUNT_INVALID');
      continue;
    }
    if (kind === 'jins' && !v.item) {
      fail('JINS_ITEM_MISSING');
      continue;
    }
    let qty: number | undefined;
    if (v.qty !== undefined) {
      const q = Number(toWesternDigits(v.qty).replace(/,/g, ''));
      if (!Number.isFinite(q) || q < 0) {
        fail('QTY_INVALID');
        continue;
      }
      qty = Math.round(q * 100) / 100;
    }
    const cancelled = erpCancelled(v.status);
    if (cancelled === null) {
      fail('STATUS_INVALID');
      continue;
    }
    lines.push({
      row,
      receiptNo,
      lineNo,
      date,
      ajeerCode,
      kind,
      amount,
      ...(v.mad ? { mad: v.mad.slice(0, 80) } : {}),
      ...(v.donor ? { donorName: v.donor.slice(0, 80) } : {}),
      ...(v.item ? { item: v.item.slice(0, 80) } : {}),
      ...(qty !== undefined ? { qty } : {}),
      ...(v.qtyUnit ? { qtyUnit: v.qtyUnit.slice(0, 20) } : {}),
      cancelled,
      ...(v.fund ? { fund: v.fund.slice(0, 40) } : {}),
      ...(v.deposit ? { deposited: !/^un/i.test(v.deposit) } : {}),
    });
  }
  return { lines, errors, rows: dataRows.length, receiptLines };
}

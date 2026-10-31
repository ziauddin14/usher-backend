import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

/**
 * Some exporters (e.g. .NET System.IO.Packaging) write absolute part paths ("/xl/workbook.xml")
 * in the .rels files and a BOM before the XML declaration. Both are valid OOXML, but ExcelJS
 * only understands relative targets — rewrite them before loading.
 */
async function normalizePackage(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  let changed = false;
  // Document properties (author, app name) are not needed for reading data, and ExcelJS cannot
  // parse them when they use namespace prefixes — drop them.
  for (const name of ['docProps/app.xml', 'docProps/core.xml']) {
    if (zip.files[name]) {
      zip.remove(name);
      changed = true;
    }
  }
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name]!;
    if (entry.dir || !/\.(rels|xml)$/i.test(name)) continue;
    let xml = await entry.async('string');
    const original = xml;
    xml = xml.replace(/^\uFEFF/, '');
    // OpenXML SDK writes the SpreadsheetML namespace with an "x:" prefix (<x:workbook>).
    const prefixed = /xmlns:x="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/;
    if (prefixed.test(xml)) {
      xml = xml
        .replace(prefixed, 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
        .replace(/<(\/?)x:/g, '<$1');
    }
    if (name.endsWith('.rels')) {
      // Rels at "<dir>/_rels/<file>.rels" resolve targets against "<dir>/".
      const base = name.replace(/_rels\/[^/]+\.rels$/, '');
      xml = xml.replace(
        /Target="\/([^"]*)"/g,
        (_m, target: string) => `Target="${posix.relative(base || '.', target)}"`,
      );
    }
    if (xml !== original) {
      zip.file(name, xml);
      changed = true;
    }
  }
  return changed ? zip.generateAsync({ type: 'nodebuffer' }) : buffer;
}

/** Load an .xlsx file, tolerating exporter quirks. */
export async function loadWorkbook(file: string): Promise<ExcelJS.Workbook> {
  const buffer = await normalizePackage(await readFile(file));
  const workbook = new ExcelJS.Workbook();
  // ExcelJS types `load` with its own Buffer interface.
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

/** Header text → comparison key: lower-case, letters and digits only (Urdu letters kept). */
export const headerKey = (s: string) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[^\p{L}\p{N}]/gu, '');

export interface SheetRow<C extends string> {
  row: number;
  values: Partial<Record<C, string>>;
}

/**
 * Read the first worksheet (or `sheetName`) into rows of known columns. The first row whose
 * cells include the `required` column is the header; title rows above it are skipped.
 */
export function readRows<C extends string>(
  workbook: ExcelJS.Workbook,
  columns: Record<C, readonly string[]>,
  required: C,
): SheetRow<C>[] {
  for (const sheet of workbook.worksheets) {
    let header: Map<number, C> | undefined;
    const rows: SheetRow<C>[] = [];
    sheet.eachRow({ includeEmpty: false }, (excelRow, rowNumber) => {
      const texts = new Map<number, string>();
      excelRow.eachCell({ includeEmpty: false }, (cell, col) => {
        texts.set(col, cell.text.trim());
      });
      if (!header) {
        const found = new Map<number, C>();
        for (const [col, text] of texts) {
          const k = headerKey(text);
          const column = (Object.keys(columns) as C[]).find((c) => columns[c].includes(k));
          if (column && ![...found.values()].includes(column)) found.set(col, column);
        }
        if ([...found.values()].includes(required)) header = found;
        return;
      }
      const values: Partial<Record<C, string>> = {};
      for (const [col, column] of header) {
        const text = texts.get(col);
        if (text) values[column] = text;
      }
      if (Object.keys(values).length > 0) rows.push({ row: rowNumber, values });
    });
    if (header) return rows;
  }
  throw new Error(`No worksheet has a header row with the "${required}" column`);
}

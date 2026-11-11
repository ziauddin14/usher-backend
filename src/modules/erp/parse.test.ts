import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  checkErpRows,
  erpAjeerCode,
  erpAmount,
  erpDate,
  ErpFileError,
  parseCsv,
  readErpTable,
} from './parse.js';

const HEADER =
  'receipt_no,line_no,receipt_date,ajeer_code,gaon_name,attiyat_type,amount_rs,mad,jins_item,jins_qty,jins_unit,status';

describe('ERP file reading (CTO 11 Nov 2026)', () => {
  it('parses CSV: BOM, quotes, "" escapes, CRLF, ; delimiter', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('reads dates as YYYY-MM-DD or day-first D/M/YYYY; amounts as whole rupees', () => {
    expect(erpDate('2026-11-05')).toBe('2026-11-05');
    expect(erpDate('2026-11-05 14:30')).toBe('2026-11-05');
    expect(erpDate('5/11/2026')).toBe('2026-11-05');
    expect(erpDate('05-11-2026')).toBe('2026-11-05');
    expect(erpDate('31/02/2026')).toBeNull();
    expect(erpDate('11/2026')).toBeNull();
    expect(erpAmount('5,000')).toBe(5000);
    expect(erpAmount('Rs 1500')).toBe(1500);
    expect(erpAmount('2500.00')).toBe(2500);
    // E-Raseed writes some values with floating-point noise: rounded to the nearest rupee.
    expect(erpAmount('2999.9999999999995')).toBe(3000);
    expect(erpAmount('2500.50')).toBe(2501);
    expect(erpAmount('-20')).toBeNull();
    expect(erpAmount('abc')).toBeNull();
    expect(erpAjeerCode('ush76680')).toBe('76680');
    expect(erpAjeerCode('USh76680')).toBe('76680');
    expect(erpAjeerCode('76680/2')).toBe('76680');
    expect(erpAjeerCode('ush03001234567')).toBeNull(); // not an Ajeer Code
  });

  it('reads the E-Raseed "General" export (Cash and Material files) as it is downloaded', () => {
    // Invented values in the export's own columns (sample files of 11 Nov 2026, 91 columns).
    const NULL = `${String.fromCharCode(92)}N`;
    const header =
      '"Region","Receipt Date","Initial Receipt Date","Receipt Number","Donor Name","User Mobile Number","User Login ID","Donation Mode","Donation Type","Purpose Name","Fund Category","Amount","Amount In Base Currency","Deposit / Undeposit","Material Item","Weight / QTY","Unit","Active / Cancel"';
    const csv = [
      header,
      `"Sindh","2026-11-09","2026-11-01","KHI-USH-ER-1","Donor A","+923000000000","ush1234567","Cash","SADQAT E NAFILA","Telethon Dawat-e-islami 2025","Nafila","20000","20000","DEPOSITED",${NULL},${NULL},${NULL},"ACTIVE"`,
      `"Sindh","2026-11-09","2026-11-01","KHI-USH-ER-1","Donor A","+923000000000","ush1234567","Cash","SADQAT E WAJIBA","Ramzan","Wajiba","25000","25000","UNDEPOSIT",${NULL},${NULL},${NULL},"ACTIVE"`,
      `"Sindh","2026-11-10","2026-11-10","M-KHI-USH-ER-7","Donor B","+923000000000","USH1234567","Material","DONATION ITEM NAFILA","Langer-e-Razavia","Nafila","2999.9999999999995","2999.9999999999995","","Rice Nafila","40","KG","ACTIVE"`,
      `"Sindh","2026-11-10","2026-11-10","KHI-USH-ER-2","Donor C","+923000000000","ush1234567","Cash","SADQAT E NAFILA","For All Purpose",${NULL},"700","700","DEPOSITED",${NULL},${NULL},${NULL},"CANCEL"`,
    ].join('\n');
    const { lines, errors, receiptLines } = checkErpRows(parseCsv(csv), '2026-11-11');
    expect(errors).toEqual([]);
    expect(lines.map((l) => `${l.receiptNo}/${l.lineNo}`)).toEqual([
      'KHI-USH-ER-1/1',
      'KHI-USH-ER-1/2',
      'M-KHI-USH-ER-7/1',
      'KHI-USH-ER-2/1',
    ]);
    expect(lines[0]).toEqual({
      row: 2,
      receiptNo: 'KHI-USH-ER-1',
      lineNo: 1,
      date: '2026-11-09',
      ajeerCode: '1234567',
      kind: 'naqd',
      amount: 20000,
      mad: 'Telethon Dawat-e-islami 2025',
      cancelled: false,
      fund: 'Nafila',
      deposited: true,
    });
    expect(lines[1]).toMatchObject({ mad: 'Ramzan', deposited: false });
    expect(lines[2]).toMatchObject({
      kind: 'jins',
      amount: 3000,
      item: 'Rice Nafila',
      qty: 40,
      qtyUnit: 'KG',
    });
    expect(lines[2]!.deposited).toBeUndefined();
    expect(lines[3]).toMatchObject({ cancelled: true });
    expect(lines[3]!.fund).toBeUndefined();
    expect(receiptLines.get('KHI-USH-ER-1')).toBe(2);
  });

  it('checks every row; a bad row is reported, the others kept', () => {
    const table = parseCsv(
      [
        'Daily receipts report', // a title row above the header is skipped
        HEADER,
        'R1,1,2026-11-10,1234567/1,Basti A,NAQAD,20000,Telethon,,,,ACTIVE',
        'R1,2,10/11/2026,1234567,Basti A,naqd,"25,000",Ramzan,,,,',
        'R2,1,2026-11-10,1234567,Basti A,JINS,5000,Ushr,Chawal,40,KG,',
        'R1,1,2026-11-10,1234567,Basti A,NAQAD,1,,,,,', // duplicate key
        'R3,1,2026-11-12,1234567,,NAQAD,100,,,,,', // after "today"
        'R4,1,2026-11-10,12,,NAQAD,100,,,,,', // bad code
        'R5,1,2026-11-10,1234567,,CHEQUE,100,,,,,',
        'R6,1,2026-11-10,1234567,,NAQAD,0,,,,,',
        'R7,1,2026-11-10,1234567,,JINS,0,,,,,', // jins without item
        'R8,1,2026-11-10,1234567,,NAQAD,100,,,,,MAYBE',
        ',,,,,,,,,,,', // empty row ignored
        'R9,1,2026-11-10,1234567,,NAQAD,700,,,,,CANCELLED',
      ].join('\n'),
    );
    const { lines, errors, rows } = checkErpRows(table, '2026-11-11');
    expect(rows).toBe(11);
    expect(lines.map((l) => `${l.receiptNo}/${l.lineNo}`)).toEqual([
      'R1/1',
      'R1/2',
      'R2/1',
      'R9/1',
    ]);
    expect(lines[0]).toMatchObject({ ajeerCode: '1234567', kind: 'naqd', amount: 20000 });
    expect(lines[1]).toMatchObject({ date: '2026-11-10', amount: 25000, mad: 'Ramzan' });
    expect(lines[2]).toMatchObject({ kind: 'jins', item: 'Chawal', qty: 40, qtyUnit: 'KG' });
    expect(lines[3]).toMatchObject({ cancelled: true });
    expect(errors).toEqual([
      { row: 6, reason: 'DUPLICATE_IN_FILE' },
      { row: 7, reason: 'DATE_IN_FUTURE' },
      { row: 8, reason: 'AJEER_CODE_INVALID' },
      { row: 9, reason: 'TYPE_INVALID' },
      { row: 10, reason: 'AMOUNT_INVALID' },
      { row: 11, reason: 'JINS_ITEM_MISSING' },
      { row: 12, reason: 'STATUS_INVALID' },
    ]);
  });

  it('names the missing required columns when there is no header', () => {
    try {
      checkErpRows(parseCsv('receipt_no,ajeer_code\nR1,1234567'), '2026-11-11');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ErpFileError);
      expect((e as ErpFileError).problem).toBe('NO_HEADER');
      expect((e as ErpFileError).missing).toEqual(['date', 'type', 'amount']);
    }
  });

  it('reads an .xlsx with real date cells the same way', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Receipts');
    ws.addRow(HEADER.split(','));
    ws.addRow([
      'R1',
      1,
      new Date(Date.UTC(2026, 10, 9)),
      1234567,
      'Basti A',
      'NAQAD',
      3000,
      'Mahana',
    ]);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const { lines, errors } = checkErpRows(await readErpTable(bytes), '2026-11-11');
    expect(errors).toEqual([]);
    expect(lines[0]).toMatchObject({ receiptNo: 'R1', date: '2026-11-09', amount: 3000 });
  });
});

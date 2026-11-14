import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { AuditLog } from '../../models/audit-log.js';
import { ErpReceipt, ErpUpload } from '../../models/erp-receipt.js';
import { Jadwal } from '../../models/jadwal.js';
import { User } from '../../models/user.js';
import { seedDemo } from '../../seed/seed.js';

// CTO 11 Nov 2026: the Pakistan level uploads the daily E-Raseed file; every level sees its own
// zimmedaran's receipts. All values invented.
const app = createApp();
const TODAY = '2026-11-11';
let pakistan: string; // 9010001
let admin: string; // 9100001 — uploads the ERP file (CTO 14 Nov 2026)
let division: string; // 9030001 Sukkur
let district: string; // 9040001 Ghotki
let zimmedar: string; // 9090412 (Ghotki)
let larkana: string; // district outside Ghotki

const HEADER =
  'receipt_no,line_no,receipt_date,ajeer_code,attiyat_type,amount_rs,mad,jins_item,jins_qty,jins_unit,status';

const upload = (cookie: string, csv: string, commit: boolean, name = 'eraseed-2026-11-10.csv') =>
  request(app)
    .post(`/api/v1/erp/uploads?name=${encodeURIComponent(name)}&commit=${commit}`)
    .set('Cookie', cookie)
    .set('Content-Type', 'text/csv')
    .send(csv);
const get = (cookie: string, url: string) =>
  request(app).get(`/api/v1${url}`).set('Cookie', cookie);

function file(rows: string[]): string {
  return [HEADER, ...rows].join('\r\n');
}

describe('ERP receipts upload and reports', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${TODAY}T07:00:00Z`) });
    await seedDemo({ reset: true });
    await ErpReceipt.deleteMany();
    await ErpUpload.deleteMany();
    await User.create({
      ajeerCode: '40002',
      name: 'Test Larkana District',
      role: 'district',
      unitCode: 'LARKANA_DIST',
      unitPath: 'PK/INT_SINDH/LARKANA/LARKANA_DIST',
      passwordHash: await bcrypt.hash('demo1234', 4),
      mustChangePassword: false,
    });
    pakistan = await loginCookie(app, '9010001');
    admin = await loginCookie(app, '9100001');
    division = await loginCookie(app, '9030001');
    district = await loginCookie(app, '9040001');
    zimmedar = await loginCookie(app, '9090412');
    larkana = await loginCookie(app, '40002');
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('only the Admin may upload or download the format (CTO 14 Nov 2026)', async () => {
    await upload(district, file([]), false).expect(403);
    await upload(zimmedar, file([]), false).expect(403);
    await get(division, '/erp/template.csv').expect(403);
    await upload(pakistan, file([]), false).expect(403); // Pakistan: view only
    const t = await get(admin, '/erp/template.csv').expect(200);
    expect(t.headers['content-disposition']).toContain('UsherDesk-ERP-format.csv');
    expect(t.text).toContain('receipt_no,line_no,receipt_date,ajeer_code');
  });

  it('a file without the required columns or rows is refused with the reason', async () => {
    const noHeader = await upload(admin, 'a,b\n1,2', false).expect(400);
    expect(noHeader.body.error.details).toMatchObject({ reason: 'ERP_FILE_NO_HEADER' });
    const empty = await upload(admin, HEADER, false).expect(400);
    expect(empty.body.error.details.reason).toBe('ERP_FILE_EMPTY');
  });

  const day1 = () =>
    file([
      `R-100,1,2026-11-10,9090412,NAQAD,20000,Telethon,,,,ACTIVE`,
      `R-100,2,2026-11-10,9090412/1,NAQAD,25000,Ramzan,,,,`,
      `R-101,1,2026-11-10,9090412,JINS,5000,Ushr,Chawal,40,KG,`,
      'R-102,1,2026-11-10,9090412,NAQAD,1000,Telethon,,,,',
      'R-103,1,2026-11-10,1111111,NAQAD,500,,,,,', // nobody with this code
    ]);

  it('preview checks the file and saves nothing', async () => {
    const res = await upload(admin, day1(), false).expect(200);
    expect(res.body).toMatchObject({
      fileName: 'eraseed-2026-11-10.csv',
      rows: 5,
      valid: 4,
      rejected: 1,
      added: 4,
      naqd: 46000,
      jins: 5000,
      zimmedaran: 1,
      dateFrom: '2026-11-10',
      dateTo: '2026-11-10',
      committed: false,
      errors: [{ row: 6, reason: 'AJEER_CODE_UNKNOWN' }],
      errorsByReason: { AJEER_CODE_UNKNOWN: 1 },
    });
    expect(await ErpReceipt.countDocuments()).toBe(0);
    expect(await ErpUpload.countDocuments()).toBe(0);
  });

  it('commit saves the valid rows once (audited); the same file again adds nothing', async () => {
    const first = await upload(admin, day1(), true).expect(201);
    expect(first.body).toMatchObject({ committed: true, added: 4, updated: 0, unchanged: 0 });
    expect(await ErpReceipt.countDocuments()).toBe(4);
    const saved = await ErpReceipt.findOne({ receiptNo: 'R-100', lineNo: 1 }).lean();
    expect(saved).toMatchObject({
      ajeerCode: '9090412',
      unitPath: expect.stringContaining('GHOTKI'),
      month: '2026-11',
    });
    expect(
      await AuditLog.countDocuments({ action: 'ERP_UPLOAD', targetId: first.body.uploadId }),
    ).toBe(1);

    const again = await upload(admin, day1(), true).expect(201);
    expect(again.body).toMatchObject({ added: 0, updated: 0, unchanged: 4 });
    expect(await ErpReceipt.countDocuments()).toBe(4);

    const list = await get(admin, '/erp/uploads').expect(200);
    expect(list.body.uploads).toHaveLength(2);
    expect(list.body.uploads[0]).toMatchObject({ added: 0, unchanged: 4, rejected: 1 });
  });

  it('a later file can cancel a line: it is updated, never deleted, and stops counting', async () => {
    const res = await upload(
      admin,
      file([`R-102,1,2026-11-10,9090412,NAQAD,1000,Telethon,,,,CANCELLED`]),
      true,
    ).expect(201);
    expect(res.body).toMatchObject({ updated: 1, cancelled: 1, naqd: 0 });
    expect(await ErpReceipt.countDocuments({ cancelled: true })).toBe(1);
  });

  it('a receipt edited in the ERP to fewer lines: the missing line is cancelled', async () => {
    const before = await ErpReceipt.countDocuments();
    const res = await upload(
      admin,
      file([`R-100,1,2026-11-10,9090412,NAQAD,20000,Telethon,,,,ACTIVE`]),
      false,
    ).expect(200);
    expect(res.body).toMatchObject({ unchanged: 1, updated: 1 });
    // Preview only: put it back as it was (both lines) before the report checks below.
    expect(await ErpReceipt.countDocuments({ receiptNo: 'R-100', cancelled: false })).toBe(2);
    const saved = await upload(
      admin,
      file([`R-100,1,2026-11-10,9090412,NAQAD,20000,Telethon,,,,ACTIVE`]),
      true,
    ).expect(201);
    expect(saved.body).toMatchObject({ updated: 1 });
    expect(await ErpReceipt.countDocuments()).toBe(before); // nothing deleted
    expect(await ErpReceipt.findOne({ receiptNo: 'R-100', lineNo: 2 }).lean()).toMatchObject({
      cancelled: true,
    });
    // The ERP brings the line back: it counts again.
    await upload(
      admin,
      file([
        `R-100,1,2026-11-10,9090412,NAQAD,20000,Telethon,,,,ACTIVE`,
        `R-100,2,2026-11-10,9090412,NAQAD,25000,Ramzan,,,,`,
      ]),
      true,
    ).expect(201);
    expect(await ErpReceipt.countDocuments({ receiptNo: 'R-100', cancelled: false })).toBe(2);
  });

  it('the District sees each zimmedar; the Division its Districts; by mad everywhere', async () => {
    const q = 'period=day&date=2026-11-10';
    const d = await get(district, `/dash/units/GHOTKI/erp?${q}`).expect(200);
    expect(d.body).toMatchObject({
      rowsKind: 'zimmedaran',
      from: '2026-11-10',
      to: '2026-11-10',
      totals: { entries: 3, receipts: 2, naqd: 45000, jins: 5000 },
      lastUpload: { dateTo: '2026-11-10' },
    });
    const mine = (d.body.rows as { ajeerCode: string }[]).find((r) => r.ajeerCode === '9090412');
    expect(mine).toMatchObject({ naqd: 45000, jins: 5000, receipts: 2 });
    // Every active zimmedar is listed, 0 when the ERP has nothing for him.
    expect(d.body.rows.length).toBeGreaterThan(1);
    expect(d.body.byMad).toEqual([
      { mad: 'Ramzan', entries: 1, receipts: 1, naqd: 25000, jins: 0 },
      { mad: 'Telethon', entries: 1, receipts: 1, naqd: 20000, jins: 0 },
      { mad: 'Ushr', entries: 1, receipts: 1, naqd: 0, jins: 5000 },
    ]);

    const div = await get(division, `/dash/units/SUKKUR/erp?${q}`).expect(200);
    expect(div.body.rowsKind).toBe('children');
    const ghotki = (div.body.rows as { unit: { code: string } }[]).find(
      (r) => r.unit.code === 'GHOTKI',
    );
    expect(ghotki).toMatchObject({ naqd: 45000, jins: 5000 });

    // Another day, a range, and scope.
    const other = await get(district, '/dash/units/GHOTKI/erp?period=day&date=2026-11-09');
    expect(other.body.totals).toMatchObject({ entries: 0, naqd: 0 });
    const range = await get(
      district,
      '/dash/units/GHOTKI/erp?period=range&from=2026-11-01&date=2026-11-11',
    ).expect(200);
    expect(range.body.totals.naqd).toBe(45000);
    await get(larkana, `/dash/units/GHOTKI/erp?${q}`).expect(404);
    await get(zimmedar, `/dash/units/GHOTKI/erp?${q}`).expect(403);
  });

  it('the zimmedar sees his own receipts by mad and line by line', async () => {
    const res = await get(zimmedar, '/me/erp?period=week&date=2026-11-10').expect(200);
    expect(res.body.totals).toMatchObject({ entries: 3, receipts: 2, naqd: 45000, jins: 5000 });
    expect(res.body.byGaon).toBeUndefined(); // no Gaon in the ERP (CTO 12 Nov 2026)
    expect(res.body.lines).toHaveLength(3);
    expect(res.body.lines[0]).toMatchObject({ receiptNo: 'R-100', lineNo: 1, mad: 'Telethon' });
    await get(district, '/me/erp?period=day').expect(403);
  });

  it('donor names, what the zimmedar wrote vs the ERP, and his detail for the District (CTO 13 Nov)', async () => {
    const me = await User.findOne({ ajeerCode: '9090412' }).lean();
    await Jadwal.create({
      userId: me!._id,
      ajeerCode: '9090412',
      unitPath: me!.unitPath,
      date: '2026-11-09',
      month: '2026-11',
      entryType: 'amli',
      status: 'submitted',
      startedAt: new Date(),
      submittedAt: new Date(),
      visits: [],
      totals: { wusooli: 60000 },
    });
    await upload(
      admin,
      [
        'receipt_no,receipt_date,ajeer_code,attiyat_type,amount_rs,mad,donor_name',
        'R-200,2026-11-09,9090412,NAQAD,40000,Ramzan,Donor Alif',
        'R-201,2026-11-09,9090412,NAQAD,15000,Telethon,Donor Alif',
        'R-202,2026-11-09,9090412,NAQAD,5000,Telethon,Donor Be',
      ].join('\n'),
      true,
    ).expect(201);
    const q = 'period=day&date=2026-11-09';

    const own = await get(zimmedar, `/me/erp?${q}`).expect(200);
    expect(own.body.totals).toMatchObject({ naqd: 60000, written: 60000 });
    expect(own.body.byDonor).toEqual([
      { donor: 'Donor Alif', naqd: 55000, jins: 0, receipts: 2 },
      { donor: 'Donor Be', naqd: 5000, jins: 0, receipts: 1 },
    ]);
    expect(own.body.lines[0]).toMatchObject({ donorName: 'Donor Alif' });

    const unit = await get(district, `/dash/units/GHOTKI/erp?${q}`).expect(200);
    expect(unit.body.totals).toMatchObject({ naqd: 60000, written: 60000 });
    const row = (unit.body.rows as { ajeerCode: string; written: number; naqd: number }[]).find(
      (r) => r.ajeerCode === '9090412',
    );
    expect(row).toMatchObject({ written: 60000, naqd: 60000 });
    const div = await get(division, `/dash/units/SUKKUR/erp?${q}`).expect(200);
    expect(
      (div.body.rows as { unit: { code: string }; written: number }[]).find(
        (r) => r.unit.code === 'GHOTKI',
      )!.written,
    ).toBe(60000);

    const detail = await get(district, `/dash/zimmedaran/${String(me!._id)}/erp?${q}`).expect(200);
    expect(detail.body.user).toMatchObject({ ajeerCode: '9090412' });
    expect(detail.body.byDonor).toHaveLength(2);
    await get(larkana, `/dash/zimmedaran/${String(me!._id)}/erp?${q}`).expect(404);
  });

  it('a too large file is refused', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024 + 10);
    const res = await upload(admin, big, false).expect(413);
    expect(res.body.error.details.reason).toBe('TOO_LARGE');
  });
});

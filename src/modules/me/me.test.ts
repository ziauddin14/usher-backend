import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { User } from '../../models/user.js';
import { DEMO_MONTHLY_H2, seedHistory } from '../../seed/history.js';
import { seedDemo } from '../../seed/seed.js';

const app = createApp();
const TODAY = '2026-11-01';
let arif: string;

interface Reward {
  divisor: number;
  periodKey: string;
  months: { month: string; amount: number; state: string; recordDays: number }[];
  total: number;
  monthsPassed: number;
  runningAvg: number;
  remainingMonths: string[];
  earned: number;
  tiers: { amount: number; needed: number; achieved: boolean }[];
  previous: { periodKey: string; total: number; avg: number; amount: number; recordDays: number };
}
interface Summary {
  from: string;
  to: string;
  recordDays: number;
  kpis: Record<string, number>;
  last7Days: { date: string; wusooli: number | null }[];
}

const get = (url: string, cookie = arif) => request(app).get(`/api/v1${url}`).set('Cookie', cookie);
const post = (url: string, body: object = {}) =>
  request(app).post(`/api/v1${url}`).set('Cookie', arif).send(body);
const reward = async () => (await get('/me/reward').expect(200)).body as Reward;
const summary = async (query: string) =>
  (await get(`/me/summary?${query}`).expect(200)).body as Summary;

/** Submit today's day with the given wusooli entries in one village. */
async function submitToday(entries: { category: string; amount: number }[]): Promise<void> {
  const village = (await get('/villages').expect(200)).body.villages[0] as { id: string };
  const created = (
    await post('/jadwals', { entryType: 'amli', travel: { mode: 'bike', meterStart: 10 } }).expect(
      201,
    )
  ).body.jadwal as { id: string };
  // POST /jadwals/:id/visits answers with the whole jadwal; the new visit is the last one.
  const withVisit = (
    await post(`/jadwals/${created.id}/visits`, { villageId: village.id }).expect(201)
  ).body.jadwal as { id: string; visits: { id: string }[] };
  const visit = withVisit.visits.at(-1)!;
  await request(app)
    .put(`/api/v1/jadwals/${created.id}/visits/${visit.id}/atiyat`)
    .set('Cookie', arif)
    .send({ entries: entries.map((e) => ({ type: 'wusooli', kind: 'naqd', ...e })) })
    .expect(200);
  await post(`/jadwals/${created.id}/submit`, { meterEnd: 40 }).expect(200);
}

describe('zimmedar khulasa, reward and export (A11, A12)', () => {
  beforeAll(async () => {
    // Fix the clock to the demo day; only Date is faked so the database driver keeps its timers.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${TODAY}T07:00:00Z`) });
    await seedDemo({ reset: true });
    await seedHistory(TODAY, { ajeerCodes: ['9090412'] });
    arif = await loginCookie(app, '9090412');
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('A12: Jun–Oct as in the design, average = total ÷ 6, needed 202,000 / 802,000', async () => {
    const r = await reward();
    expect(r.months.slice(0, 5).map((m) => m.amount)).toEqual(Object.values(DEMO_MONTHLY_H2));
    expect(r).toMatchObject({
      periodKey: 'H2-2026',
      total: 998_000,
      monthsPassed: 6, // November is the current month (no records yet)
      runningAvg: 166_333,
      remainingMonths: ['2026-11'],
      earned: 0,
      divisor: 6,
    });
    expect(r.tiers.map((t) => t.needed)).toEqual([202_000, 802_000]);
    expect(r.months[0]!.recordDays).toBeGreaterThan(0);
    expect(r.months.at(-1)).toMatchObject({
      month: '2026-11',
      amount: 0,
      state: 'current',
      recordDays: 0,
    });
  });

  it('A12 previous period (Dec 2025 – May 2026): average 214,000 → Rs 5,000', async () => {
    const r = await reward();
    expect(r.previous).toMatchObject({
      periodKey: 'H1-2026',
      total: 1_284_000,
      avg: 214_000,
      amount: 5_000,
    });
    expect(r.previous.recordDays).toBeGreaterThan(100);
  });

  it('A11: reward wusooli of October; today without a jadwal is "no record", not zero', async () => {
    const s = await summary('period=month&date=2026-10-15');
    expect(s).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(s.kpis.rewardWusooli).toBe(198_000);
    expect(s.kpis.wusooli).toBeGreaterThan(198_000); // excluded purposes count only in "kul"
    const today = await summary('period=day');
    expect(today).toMatchObject({ from: TODAY, to: TODAY, recordDays: 0 });
    expect(today.last7Days).toHaveLength(7);
    expect(today.last7Days.at(-1)).toEqual({ date: TODAY, wusooli: null });

    const week = await summary('period=week&date=2026-10-29');
    expect(week).toMatchObject({ from: '2026-10-26', to: TODAY }); // Monday → never past today
  });

  it('six-month summary: the current and the previous reward period from saved records', async () => {
    const current = await summary('period=reward');
    expect(current).toMatchObject({ from: '2026-06-01', to: TODAY });
    expect(current.kpis.rewardWusooli).toBe(998_000);

    const previous = await summary('period=reward&date=2026-03-10');
    expect(previous).toMatchObject({ from: '2025-12-01', to: '2026-05-31' });
    expect(previous.kpis.rewardWusooli).toBe(1_284_000);
  });

  it('a zimmedar moved to another district keeps the own history (own userId, not unit path)', async () => {
    const before = await reward();
    const arifUser = await User.findOne({ ajeerCode: '9090412' }).lean();
    await User.updateOne(
      { _id: arifUser!._id },
      { $set: { unitCode: 'SUKKUR_DIST', unitPath: 'PK/INT_SINDH/SUKKUR/SUKKUR_DIST' } },
    );
    try {
      const moved = await reward();
      expect(moved.total).toBe(before.total);
      expect(moved.previous.total).toBe(before.previous.total);
      expect((await summary('period=month&date=2026-10-15')).kpis.rewardWusooli).toBe(198_000);
    } finally {
      await User.updateOne(
        { _id: arifUser!._id },
        { $set: { unitCode: arifUser!.unitCode, unitPath: arifUser!.unitPath } },
      );
    }
  });

  it('Excel for a period without any jadwal: "no record" rows and no zero totals', async () => {
    const res = await get(`/me/export.xlsx?period=day&date=${TODAY}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(3).getCell(2).text).toBe('ریکارڈ نہیں');
    const totals = ws.getRow(ws.rowCount);
    expect(totals.getCell(2).text).toBe('ریکارڈ نہیں');
    expect(totals.getCell(8).text).toBe('');
  });

  it('submitting a day changes A11 at once; an excluded purpose changes only the "kul" figures', async () => {
    const before = await reward();
    await submitToday([
      { category: 'mahana', amount: 5_000 },
      { category: 'tameer', amount: 2_000 },
    ]);
    const day = await summary('period=day');
    expect(day.kpis).toMatchObject({
      wusooli: 7_000,
      rewardWusooli: 5_000,
      excludedWusooli: 2_000,
    });
    expect(day.last7Days.at(-1)).toEqual({ date: TODAY, wusooli: 7_000 });
    const after = await reward();
    expect(after.total).toBe(before.total + 5_000);
    expect(after.runningAvg).toBe(Math.floor(1_003_000 / 6));
    expect(after.tiers[0]!.needed).toBe(197_000);
  });

  it('downloads an Excel file: Urdu headers, right-to-left, one row per day + totals', async () => {
    const res = await get('/me/export.xlsx?period=month&date=2026-10-15')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-disposition']).toContain('ushr-9090412-month-2026-10-15.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.views[0]).toMatchObject({ rightToLeft: true });
    const header = ws.getRow(2);
    expect(header.getCell(1).text).toBe('تاریخ');
    expect(header.cellCount).toBe(14);
    expect(ws.rowCount).toBe(2 + 31 + 1);
    const totals = ws.getRow(ws.rowCount);
    expect(totals.getCell(1).text).toBe('کل');
    expect(totals.getCell(8).value).toBe(198_000); // reward wusooli column
  });

  it('only zimmedaran have /me', async () => {
    const district = await loginCookie(app, '9040001');
    await get('/me/summary', district).expect(403);
    await get('/me/reward', district).expect(403);
    await get('/me/export.xlsx', district).expect(403);
    await get('/me/summary?period=year').expect(400);
  });
});

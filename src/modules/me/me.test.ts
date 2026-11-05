import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { DEMO_MONTHLY, seedHistory } from '../../seed/history.js';
import { seedDemo } from '../../seed/seed.js';

const app = createApp();
const TODAY = '2026-10-31';
let arif: string;

const get = (url: string, cookie = arif) => request(app).get(`/api/v1${url}`).set('Cookie', cookie);
const post = (url: string, body: object = {}) =>
  request(app).post(`/api/v1${url}`).set('Cookie', arif).send(body);

/** Submit today's day with one reward-included and one excluded wusooli entry. */
async function submitToday(entries: { category: string; amount: number }[]): Promise<void> {
  const village = (await get('/villages').expect(200)).body.villages[0] as { id: string };
  const jadwal = (
    await post('/jadwals', { entryType: 'amli', travel: { mode: 'bike', meterStart: 10 } }).expect(
      201,
    )
  ).body.jadwal as { id: string };
  const visit = (await post(`/jadwals/${jadwal.id}/visits`, { villageId: village.id }).expect(201))
    .body.visit as { id: string };
  await request(app)
    .put(`/api/v1/jadwals/${jadwal.id}/visits/${visit.id}/atiyat`)
    .set('Cookie', arif)
    .send({ entries: entries.map((e) => ({ type: 'wusooli', kind: 'naqd', ...e })) })
    .expect(200);
  await post(`/jadwals/${jadwal.id}/submit`, { meterEnd: 40 }).expect(200);
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

  it('A12 shows exactly the design numbers (Jun–Oct, 199,600, 202,000 / 802,000)', async () => {
    const r = (await get('/me/reward').expect(200)).body;
    expect(r.months.slice(0, 5).map((m: { amount: number }) => m.amount)).toEqual(
      Object.values(DEMO_MONTHLY),
    );
    expect(r).toMatchObject({
      periodId: 'H2',
      total: 998_000,
      monthsPassed: 5,
      runningAvg: 199_600,
      remainingMonths: ['2026-11'],
    });
    expect(r.tiers.map((t: { needed: number }) => t.needed)).toEqual([202_000, 802_000]);
    // No records before June 2026 → the previous period is "no record", not a result.
    expect(r.previous).toMatchObject({ periodKey: 'H1-2026', recordDays: 0, amount: 0 });
  });

  it('A11 month: reward wusooli of October, last 7 days with today as "no record"', async () => {
    const s = (await get('/me/summary?period=month').expect(200)).body;
    expect(s).toMatchObject({ from: '2026-10-01', to: TODAY });
    expect(s.kpis.rewardWusooli).toBe(198_000);
    expect(s.kpis.wusooli).toBeGreaterThan(198_000); // excluded purposes count only in "kul"
    expect(s.last7Days).toHaveLength(7);
    expect(s.last7Days.at(-1)).toEqual({ date: TODAY, wusooli: null });

    const week = (await get('/me/summary?period=week&date=2026-10-29').expect(200)).body;
    expect(week).toMatchObject({ from: '2026-10-26', to: TODAY }); // Monday → never past today
  });

  it('submitting a day changes A11 at once; an excluded purpose changes only the "kul" figures', async () => {
    const before = (await get('/me/reward').expect(200)).body;
    await submitToday([
      { category: 'mahana', amount: 5_000 },
      { category: 'tameer', amount: 2_000 },
    ]);
    const day = (await get('/me/summary?period=day').expect(200)).body;
    expect(day.kpis).toMatchObject({
      wusooli: 7_000,
      rewardWusooli: 5_000,
      excludedWusooli: 2_000,
    });
    const after = (await get('/me/reward').expect(200)).body;
    expect(after.total).toBe(before.total + 5_000);
    expect(after.tiers[0].needed).toBe(197_000);
  });

  it('downloads an Excel file: Urdu headers, right-to-left, one row per day + totals', async () => {
    const res = await get('/me/export.xlsx?period=month')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-disposition']).toContain('ushr-9090412-month-2026-10-31.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.views[0]).toMatchObject({ rightToLeft: true });
    expect(ws.getRow(2).getCell(1).text).toBe('تاریخ');
    expect(ws.rowCount).toBe(2 + 31 + 1);
    expect(ws.getRow(ws.rowCount).getCell(1).text).toBe('کل');
  });

  it('only zimmedaran have /me', async () => {
    const district = await loginCookie(app, '9040001');
    await get('/me/summary', district).expect(403);
    await get('/me/summary?period=year').expect(400);
  });
});

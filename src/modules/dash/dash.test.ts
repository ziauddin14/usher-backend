import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { AuditLog } from '../../models/audit-log.js';
import { Jadwal } from '../../models/jadwal.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedHistory } from '../../seed/history.js';
import { seedDemo } from '../../seed/seed.js';

const app = createApp();
const TODAY = '2026-11-01';
let district: string; // 9040001 Ghotki
let division: string; // 9030001 Sukkur
let pakistan: string; // 9010001
let zimmedar: string; // 9090412
let larkanaDistrict: string;

const get = (url: string, cookie: string) =>
  request(app).get(`/api/v1${url}`).set('Cookie', cookie);
const post = (url: string, cookie: string, body: object = {}) =>
  request(app).post(`/api/v1${url}`).set('Cookie', cookie).send(body);

interface Row {
  id: string;
  ajeerCode: string;
  today: string;
  recordDays: number;
  kpis: Record<string, number>;
  avg: number;
  periodTotal: number;
  reward: { kind: string; amount?: number };
}

describe('dashboards (B1 / B2)', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${TODAY}T07:00:00Z`) });
    await seedDemo({ reset: true });
    const ghotki = await User.find({ role: 'zimmedar', unitCode: 'GHOTKI' }).lean();
    await seedHistory(TODAY, { ajeerCodes: ghotki.map((u) => u.ajeerCode) });
    await User.create({
      ajeerCode: '40002',
      name: 'Test Larkana District',
      role: 'district',
      unitCode: 'LARKANA_DIST',
      unitPath: 'PK/INT_SINDH/LARKANA/LARKANA_DIST',
      passwordHash: await bcrypt.hash('demo1234', 4),
      mustChangePassword: false,
    });
    district = await loginCookie(app, '9040001');
    division = await loginCookie(app, '9030001');
    pakistan = await loginCookie(app, '9010001');
    zimmedar = await loginCookie(app, '9090412');
    larkanaDistrict = await loginCookie(app, '40002');
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('zimmedaran get 403 on every /dash route', async () => {
    for (const url of [
      '/dash/units/GHOTKI/overview',
      '/dash/units/GHOTKI/zimmedaran',
      '/dash/units/SUKKUR/children',
      '/dash/units/GHOTKI/villages',
      '/dash/export.xlsx?view=zimmedaran&code=GHOTKI',
    ]) {
      await get(url, zimmedar).expect(403);
    }
  });

  it('scope: a district sees only itself, a division only its districts (404 outside)', async () => {
    await get('/dash/units/GHOTKI/overview', district).expect(200);
    await get('/dash/units/LARKANA_DIST/overview', district).expect(404);
    await get('/dash/units/GHOTKI/zimmedaran', larkanaDistrict).expect(404);
    await get('/dash/units/SUKKUR/children', district).expect(404); // above the district
    await get('/dash/units/GHOTKI/zimmedaran', division).expect(200);
    await get('/dash/units/LARKANA/children', division).expect(404);
    await get('/dash/units/NOPE/overview', pakistan).expect(404);
  });

  it('B1: the 9090412 row matches A12 (same rewardStatus) and the tiles are the sum of the rows', async () => {
    const t = (
      await get('/dash/units/GHOTKI/zimmedaran?period=month&date=2026-10-15', district).expect(200)
    ).body as { rows: Row[] };
    expect(t.rows).toHaveLength(10);
    const arif = t.rows.find((r) => r.ajeerCode === '9090412')!;
    const me = (await get('/me/reward', zimmedar).expect(200)).body as {
      runningAvg: number;
      total: number;
    };
    expect(arif).toMatchObject({ avg: me.runningAvg, periodTotal: me.total });
    expect(arif.avg).toBe(166_333);
    expect(arif.reward).toEqual({ kind: 'peeche' }); // 166,333 < 85% of 200,000
    const oct = (await get('/me/summary?period=month&date=2026-10-15', zimmedar).expect(200))
      .body as {
      kpis: Record<string, number>;
    };
    expect(arif.kpis).toEqual(oct.kpis);

    const o = (
      await get('/dash/units/GHOTKI/overview?period=month&date=2026-10-15', district).expect(200)
    ).body as { tiles: { zimmedaran: number; recordDays: number; kpis: Record<string, number> } };
    expect(o.tiles.zimmedaran).toBe(10);
    expect(o.tiles.kpis.rewardWusooli).toBe(
      t.rows.reduce((s, r) => s + (r.kpis.rewardWusooli ?? 0), 0),
    );
    expect(o.tiles.recordDays).toBe(t.rows.reduce((s, r) => s + r.recordDays, 0));
  });

  it("today's status and the two measures: submission (rukhsat too) vs field activity", async () => {
    const ghotki = await User.find({ role: 'zimmedar', unitCode: 'GHOTKI' })
      .sort({ ajeerCode: 1 })
      .lean();
    const [a, b, c, d, e, f] = ghotki;
    const base = (u: (typeof ghotki)[number]) => ({
      userId: u._id,
      ajeerCode: u.ajeerCode,
      unitPath: u.unitPath,
      date: TODAY,
      month: '2026-11',
      startedAt: new Date(),
      visits: [],
    });
    await Jadwal.create([
      { ...base(a!), entryType: 'amli', status: 'submitted', submittedAt: new Date() },
      { ...base(b!), entryType: 'amli', status: 'draft' },
      { ...base(c!), entryType: 'rukhsat', status: 'submitted', submittedAt: new Date() },
      { ...base(d!), entryType: 'qafila', status: 'submitted', submittedAt: new Date() },
      { ...base(e!), entryType: 'course', status: 'submitted', submittedAt: new Date() },
      { ...base(f!), entryType: 'mashwara_full', status: 'submitted', submittedAt: new Date() },
    ]);
    const rows = (await get('/dash/units/GHOTKI/zimmedaran', district).expect(200)).body
      .rows as Row[];
    const by = new Map(rows.map((r) => [r.ajeerCode, r.today]));
    expect(by.get(a!.ajeerCode)).toBe('jama');
    expect(by.get(b!.ajeerCode)).toBe('jari');
    expect(by.get(c!.ajeerCode)).toBe('rukhsat');
    expect(rows.filter((r) => r.today === 'nahi')).toHaveLength(4);
    // Submission % numerator: a (amli), c (rukhsat), d, e, f = 5 · Field Activity: a, d, e, f = 4.
    // b is a draft (neither); denominator = 10 active zimmedaran.
    const o = (await get('/dash/units/GHOTKI/overview', district).expect(200)).body as {
      tiles: { zimmedaran: number; today: { submitted: number; field: number; jari: number } };
    };
    expect(o.tiles.zimmedaran).toBe(10);
    expect(o.tiles.today).toMatchObject({ submitted: 5, field: 4, jari: 1 });
    const kids = (await get('/dash/units/SUKKUR/children', division).expect(200)).body as {
      rows: { unit: { code: string }; today: { submitted: number; field: number } }[];
    };
    expect(kids.rows.find((r) => r.unit.code === 'GHOTKI')!.today).toMatchObject({
      submitted: 5,
      field: 4,
    });
  });

  it('B2: division children are its districts; pakistan children are the subas', async () => {
    const d = (
      await get('/dash/units/SUKKUR/children?period=month&date=2026-10-15', division).expect(200)
    ).body as {
      childLevel: string;
      rows: { unit: { code: string }; zimmedaran: number; kpis: Record<string, number> }[];
    };
    expect(d.childLevel).toBe('district');
    expect(d.rows.map((r) => r.unit.code).sort()).toEqual(['GHOTKI', 'KHAIRPUR', 'SUKKUR_DIST']);
    const ghotki = d.rows.find((r) => r.unit.code === 'GHOTKI')!;
    const b1 = (
      await get('/dash/units/GHOTKI/overview?period=month&date=2026-10-15', division).expect(200)
    ).body as { tiles: { kpis: Record<string, number> } };
    expect(ghotki.kpis).toEqual(b1.tiles.kpis);
    const p = (await get('/dash/units/PK/children', pakistan).expect(200)).body as {
      rows: { unit: { code: string } }[];
    };
    expect(p.rows.map((r) => r.unit.code).sort()).toEqual(['INT_SINDH', 'PUNJAB']);
    await get('/dash/units/GHOTKI/children', district).expect(400);
  });

  it('zimmedar detail: day list in scope only', async () => {
    const arif = await User.findOne({ ajeerCode: '9090412' }).lean();
    const days = (
      await get(`/dash/zimmedaran/${String(arif!._id)}/days?month=2026-10`, district).expect(200)
    ).body as { days: { date: string; totals: Record<string, number> | null }[] };
    expect(days.days.length).toBeGreaterThan(20);
    expect(days.days.reduce((s, d) => s + (d.totals?.rewardWusooli ?? 0), 0)).toBe(198_000);
    await get(`/dash/zimmedaran/${String(arif!._id)}/days`, larkanaDistrict).expect(404);
  });

  it('villages per zimmedar: assigned, not visited this month, district pool', async () => {
    const v = (await get('/dash/units/GHOTKI/villages?month=2026-10', district).expect(200))
      .body as {
      zimmedaran: {
        ajeerCode: string;
        assigned: number;
        notVisited: { id: string }[];
        villages: { visited: boolean }[];
      }[];
      pool: unknown[];
    };
    const arif = v.zimmedaran.find((z) => z.ajeerCode === '9090412')!;
    expect(arif.assigned).toBe(5);
    expect(arif.notVisited.length).toBe(arif.villages.filter((x) => !x.visited).length);
    expect(Array.isArray(v.pool)).toBe(true);
  });

  it('villages: approve with a spelling fix, merge, assign from the pool and transfer — all audited', async () => {
    const ghotki = await User.find({ role: 'zimmedar', unitCode: 'GHOTKI' })
      .sort({ ajeerCode: 1 })
      .lean();
    const [a, b] = ghotki;
    const pending = await Village.create({
      name: 'گوٹھ نیا گاؤں',
      nameKey: 'نیا گاؤں',
      districtCode: 'GHOTKI',
      unitPath: a!.unitPath,
      status: 'pending',
      addedBy: a!._id,
      assignedTo: a!._id,
    });
    const list = (await get('/villages/pending', district).expect(200)).body.villages as {
      id: string;
    }[];
    expect(list.map((x) => x.id)).toContain(String(pending._id));
    await get('/villages/pending', zimmedar).expect(403);
    await get('/villages/pending', larkanaDistrict)
      .expect(200)
      .expect((r) => {
        expect((r.body.villages as { id: string }[]).map((x) => x.id)).not.toContain(
          String(pending._id),
        );
      });
    await post(`/villages/${String(pending._id)}/approve`, larkanaDistrict).expect(404);
    const ok = await post(`/villages/${String(pending._id)}/approve`, district, {
      name: 'گوٹھ نیا گاؤں خورد',
    }).expect(200);
    expect(ok.body.village).toMatchObject({ status: 'approved', name: 'گوٹھ نیا گاؤں خورد' });
    expect(
      await AuditLog.countDocuments({ action: 'VILLAGE_APPROVE', targetId: String(pending._id) }),
    ).toBe(1);

    // A pool village (no zimmedar) → b, then transfer b → a.
    const pool = await Village.create({
      name: 'گوٹھ پول',
      nameKey: 'پول',
      districtCode: 'GHOTKI',
      unitPath: a!.unitPath,
      status: 'approved',
    });
    await post(`/villages/${String(pool._id)}/assign`, district, { userId: String(b!._id) }).expect(
      200,
    );
    await post(`/villages/${String(pool._id)}/assign`, district, { userId: String(a!._id) }).expect(
      200,
    );
    expect(String((await Village.findById(pool._id).lean())!.assignedTo)).toBe(String(a!._id));
    const moves = await AuditLog.find({ action: 'VILLAGE_REASSIGN', targetId: String(pool._id) })
      .sort({ _id: 1 }) // the faked clock gives both the same `at`
      .lean();
    expect(moves.map((m) => (m.details as { from: unknown }).from)).toEqual([
      null,
      { id: String(b!._id), ajeerCode: b!.ajeerCode },
    ]);
    // Only a zimmedar of the village's own district.
    const larkanaZ = await User.findOne({ role: 'zimmedar', unitCode: 'LARKANA_DIST' }).lean();
    await post(`/villages/${String(pool._id)}/assign`, division, {
      userId: String(larkanaZ!._id),
    }).expect(409);

    // Merge the pool village into the approved one; it is kept as history, never deleted.
    await post(`/villages/${String(pool._id)}/merge`, district, {
      intoId: String(pending._id),
    }).expect(200);
    expect(await Village.findById(pool._id).lean()).toMatchObject({ status: 'merged' });
    expect(await AuditLog.countDocuments({ action: 'VILLAGE_MERGE' })).toBe(1);
  });

  it('users: deactivate ends the sessions at once (audited); reactivate', async () => {
    const z = await User.findOne({
      role: 'zimmedar',
      unitCode: 'GHOTKI',
      ajeerCode: { $ne: '9090412' },
    })
      .sort({ ajeerCode: -1 })
      .lean();
    const cookie = await loginCookie(app, z!.ajeerCode);
    await get('/meta', cookie).expect(200);
    await post(`/users/${String(z!._id)}/status`, zimmedar, { isActive: false }).expect(403);
    await post(`/users/${String(z!._id)}/status`, larkanaDistrict, { isActive: false }).expect(404);
    await post(`/users/${String(z!._id)}/status`, district, { isActive: false }).expect(200);
    await get('/meta', cookie).expect(401);
    expect(await AuditLog.countDocuments({ action: 'USER_STATUS', targetId: String(z!._id) })).toBe(
      1,
    );
    const rows = (await get('/dash/units/GHOTKI/zimmedaran', district).expect(200)).body
      .rows as Row[];
    expect(rows.map((r) => r.id)).not.toContain(String(z!._id));
    await post(`/users/${String(z!._id)}/status`, district, { isActive: true }).expect(200);
    await loginCookie(app, z!.ajeerCode);
  });

  it('Excel: zimmedaran / children / days with a totals row; Server-Timing header', async () => {
    const xlsx = async (url: string) => {
      const res = await get(url, division)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as ArrayBuffer);
      return { ws: wb.worksheets[0]!, res };
    };
    const z = await xlsx(
      '/dash/export.xlsx?view=zimmedaran&code=GHOTKI&period=month&date=2026-10-15',
    );
    expect(z.res.headers['content-disposition']).toContain('ushr-GHOTKI-month-2026-10-15.xlsx');
    expect(z.ws.rowCount).toBe(2 + 10 + 1);
    expect(z.ws.getRow(z.ws.rowCount).getCell(1).text).toBe('Kul');
    const c = await xlsx(
      '/dash/export.xlsx?view=children&code=SUKKUR&period=month&date=2026-10-15',
    );
    expect(c.ws.rowCount).toBe(2 + 3 + 1);
    const arif = await User.findOne({ ajeerCode: '9090412' }).lean();
    const d = await xlsx(`/dash/export.xlsx?view=days&userId=${String(arif!._id)}&month=2026-10`);
    expect(d.ws.getRow(d.ws.rowCount).getCell(9).value).toBe(198_000);
    expect(z.res.headers['server-timing']).toMatch(/^app;dur=\d+$/);
  });
});

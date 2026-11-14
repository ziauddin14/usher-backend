// The Admin (CTO 14 Nov 2026): the only role that changes data. A new zimmedar account, the direct
// correction of a submitted jadwal, and the audit log that shows which Admin did what. District,
// Division, Suba and Pakistan only view. Invented seed data only.
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { AuditLog } from '../../models/audit-log.js';
import { Jadwal } from '../../models/jadwal.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';

const app = createApp();
let admin: string; // 9100001
let admin2: string; // a second Admin, created here
let district: string; // 9040001 Ghotki
let pakistan: string; // 9010001
let arif: string; // 9090412 Ghotki zimmedar
let arifVillages: string[];

const api = (cookie: string) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', cookie),
  post: (url: string, body: object = {}) =>
    request(app).post(`/api/v1${url}`).set('Cookie', cookie).send(body),
  put: (url: string, body: object) =>
    request(app).put(`/api/v1${url}`).set('Cookie', cookie).send(body),
});

beforeAll(async () => {
  await seedDemo({ reset: true });
  await User.create({
    ajeerCode: '9100002',
    name: 'Second Admin',
    role: 'admin',
    unitCode: 'PK',
    unitPath: 'PK',
    passwordHash: await bcrypt.hash('demo1234', 4),
    mustChangePassword: false,
    provisioned: { nominationRef: 'NOM/1', approvalRef: 'APR/1', operator: 'test', at: new Date() },
  });
  admin = await loginCookie(app, '9100001');
  admin2 = await loginCookie(app, '9100002');
  district = await loginCookie(app, '9040001');
  pakistan = await loginCookie(app, '9010001');
  arif = await loginCookie(app, '9090412');
  const arifId = (await User.findOne({ ajeerCode: '9090412' }).lean())!._id;
  arifVillages = (await Village.find({ assignedTo: arifId }).sort({ nameKey: 1 }).lean()).map((v) =>
    String(v._id),
  );
});

describe('Admin: a new zimmedar account', () => {
  const body = {
    ajeerCode: '7700001',
    name: 'Naya Zimmedar',
    districtCode: 'GHOTKI',
    zimmedari: 'ushar',
  };

  it('only the Admin creates one; supervisors only view', async () => {
    await api(district).post('/users', body).expect(403);
    await api(pakistan).post('/users', body).expect(403);
    await api(arif).post('/users', body).expect(403);
    expect(await User.exists({ ajeerCode: '7700001' })).toBeNull();
  });

  it('creates a zimmedar of the District with the initial password and a forced change (audited)', async () => {
    const res = await api(admin).post('/users', body).expect(201);
    const u = await User.findOne({ ajeerCode: '7700001' }).select('+passwordHash').lean();
    expect(u).toMatchObject({
      role: 'zimmedar',
      zimmedari: 'ushar',
      unitCode: 'GHOTKI',
      unitPath: 'PK/INT_SINDH/SUKKUR/GHOTKI',
      mustChangePassword: true,
      isActive: true,
    });
    expect(res.body.user).toEqual({ id: String(u!._id), ajeerCode: '7700001' });
    expect(await bcrypt.compare('demo1234', u!.passwordHash)).toBe(true);
    expect(
      await AuditLog.findOne({ action: 'USER_CREATE', targetId: String(u!._id) }).lean(),
    ).toMatchObject({ actorAjeerCode: '9100001', details: { targetAjeerCode: '7700001' } });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ ajeerCode: '7700001', password: 'demo1234' })
      .expect(200);
    expect(login.body.user.mustChangePassword).toBe(true);
  });

  it('lists the Districts for the form (Admin only)', async () => {
    await api(district).get('/users/districts').expect(403);
    const res = await api(admin).get('/users/districts').expect(200);
    const codes = (res.body.districts as { code: string }[]).map((d) => d.code);
    expect(codes).toContain('GHOTKI');
    expect(codes).not.toContain('SUKKUR');
  });

  it('refuses an existing Ajeer Code, a unit that is not a District and a bad mobile', async () => {
    const dup = await api(admin).post('/users', body).expect(409);
    expect(dup.body.error.details).toMatchObject({ field: 'ajeerCode' });
    await api(admin)
      .post('/users', { ...body, ajeerCode: '7700002', districtCode: 'SUKKUR' })
      .expect(400);
    await api(admin)
      .post('/users', { ...body, ajeerCode: '7700003', mobile: '12345' })
      .expect(400);
    await api(admin)
      .post('/users', { ...body, ajeerCode: '7700004', zimmedari: 'district' })
      .expect(400);
  });
});

describe('Admin: correcting a submitted jadwal', () => {
  let id: string;
  let visitId: string;

  beforeAll(async () => {
    await Jadwal.deleteMany({ ajeerCode: '9090412' });
    const start = await api(arif)
      .post('/jadwals', { entryType: 'amli', travel: { mode: 'bike', meterStart: 1000 } })
      .expect(201);
    id = start.body.jadwal.id as string;
    const v = await api(arif).post(`/jadwals/${id}/visits`, { villageId: arifVillages[0] });
    visitId = v.body.jadwal.visits[0].id as string;
    await api(arif)
      .put(`/jadwals/${id}/visits/${visitId}/atiyat`, {
        entries: [
          { type: 'wusooli', kind: 'naqd', amount: 50000 },
          { type: 'wusooli', kind: 'jins', amount: 0, detail: 'گندم', qty: 40, unit: 'من' },
        ],
      })
      .expect(200);
  });

  it('a draft is not corrected (the zimmedar is still writing it)', async () => {
    const r = await api(admin)
      .post(`/jadwals/${id}/correct`, { reason: 'Raqam ghalat', travel: { meterEnd: 1100 } })
      .expect(409);
    expect(r.body.error.details.reason).toBe('NOT_SUBMITTED');
  });

  it('only the Admin corrects, with a reason; totals follow; before / after audited', async () => {
    await api(arif).post(`/jadwals/${id}/submit`, { meterEnd: 1060 }).expect(200);
    const fix = {
      reason: 'Raqam 5,000 thi, 50,000 nahi',
      travel: { meterEnd: 1040 },
      visits: [{ visitId, entries: [{ index: 0, amount: 5000 }] }],
    };
    await api(district).post(`/jadwals/${id}/correct`, fix).expect(403);
    await api(pakistan).post(`/jadwals/${id}/correct`, fix).expect(403);
    await api(arif).post(`/jadwals/${id}/correct`, fix).expect(403);
    await api(admin)
      .post(`/jadwals/${id}/correct`, { ...fix, reason: 'abc' })
      .expect(400);
    await api(admin).post(`/jadwals/${id}/correct`, { reason: 'Kuch nahi' }).expect(400);

    const res = await api(admin).post(`/jadwals/${id}/correct`, fix).expect(200);
    expect(res.body.jadwal).toMatchObject({
      status: 'submitted',
      travel: { meterStart: 1000, meterEnd: 1040, km: 40 },
      totals: { km: 40, wusooli: 5000 },
      corrections: [{ byAjeerCode: '9100001', reason: fix.reason }],
    });
    const log = await AuditLog.findOne({ action: 'JADWAL_CORRECT', targetId: id }).lean();
    expect(log).toMatchObject({
      actorAjeerCode: '9100001',
      details: {
        ajeerCode: '9090412',
        reason: fix.reason,
        before: { km: 60, wusooli: 50000 },
        after: { km: 40, wusooli: 5000 },
      },
    });
    expect((log!.details as { changes: string[] }).changes).toHaveLength(2);
  });

  it('a visit with no donors can move to another Gaon of the District; a removed entry stops counting', async () => {
    const other = arifVillages[1]!;
    const res = await api(admin2)
      .post(`/jadwals/${id}/correct`, {
        reason: 'Ghalat gaon chuna gaya tha',
        visits: [{ visitId, villageId: other, entries: [{ index: 0, remove: true }] }],
      })
      .expect(200);
    expect(res.body.jadwal.visits[0].villageId).toBe(other);
    expect(res.body.jadwal.visits[0].atiyat.entries).toHaveLength(1);
    expect(res.body.jadwal.totals.wusooli).toBe(0);
    expect(
      (res.body.jadwal.corrections as { byAjeerCode: string }[]).map((c) => c.byAjeerCode),
    ).toEqual(['9100001', '9100002']);
    // A Gaon of another District is refused.
    const foreign = await Village.findOne({ districtCode: { $ne: 'GHOTKI' } }).lean();
    await api(admin)
      .post(`/jadwals/${id}/correct`, {
        reason: 'Doosra district',
        visits: [{ visitId, villageId: String(foreign!._id) }],
      })
      .expect(404);
  });
});

describe('the audit log', () => {
  it('the Admin sees who did what, newest first, with the actor name; supervisors cannot', async () => {
    await api(district).get('/audit').expect(403);
    await api(pakistan).get('/audit').expect(403);
    const all = await api(admin).get('/audit').expect(200);
    const items = all.body.items as {
      action: string;
      actor: { ajeerCode: string; name: string };
    }[];
    expect(items[0]!.action).toBe('JADWAL_CORRECT');
    expect(items[0]!.actor).toMatchObject({ ajeerCode: '9100002', name: 'Second Admin' });
    expect(items.some((i) => i.action === 'LOGIN')).toBe(false); // left out unless asked for

    const mine = await api(admin).get('/audit?actor=9100001').expect(200);
    const actions = (mine.body.items as { action: string }[]).map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['USER_CREATE', 'JADWAL_CORRECT']));
    expect(
      (mine.body.items as { actor: { ajeerCode: string } }[]).every(
        (i) => i.actor.ajeerCode === '9100001',
      ),
    ).toBe(true);

    const created = await api(admin).get('/audit?action=USER_CREATE').expect(200);
    expect(created.body.total).toBe(1);
    const logins = await api(admin).get('/audit?logins=1&action=LOGIN').expect(200);
    expect(logins.body.total).toBeGreaterThan(0);
    await api(admin).get('/audit?action=NOPE').expect(400);

    const admins = await api(admin).get('/audit/admins').expect(200);
    expect((admins.body.admins as { ajeerCode: string }[]).map((a) => a.ajeerCode).sort()).toEqual([
      '9100001',
      '9100002',
    ]);
  });
});

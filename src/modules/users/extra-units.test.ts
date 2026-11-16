import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { AuditLog } from '../../models/audit-log.js';
import { User } from '../../models/user.js';
import { seedDemo } from '../../seed/seed.js';

type Coded = { code: string }[];
const codes = (x: unknown) => (x as Coded).map((u) => u.code);

// CTO 17 Nov 2026: a Division zimmedar holding a second Division views it like his own.
describe('extra units (Admin gives a second Division)', () => {
  const app = createApp();
  let admin = '';
  let division = '';
  let divisionId = '';

  beforeAll(async () => {
    await seedDemo({ reset: true });
    admin = await loginCookie(app, '9100001');
    division = await loginCookie(app, '9030001'); // Sukkur Division
    divisionId = String((await User.findOne({ ajeerCode: '9030001' }).lean())!._id);
  });

  const put = (cookie: string, id: string, unitCodes: string[]) =>
    request(app).put(`/api/v1/users/${id}/extra-units`).set('Cookie', cookie).send({ unitCodes });

  it('before: the other Division is out of scope (404)', async () => {
    await request(app)
      .get('/api/v1/dash/units/LARKANA/overview?period=day')
      .set('Cookie', division)
      .expect(404);
  });

  it('only the Admin gives it', async () => {
    const res = await put(division, divisionId, ['LARKANA']).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('only a unit of the same level', async () => {
    const res = await put(admin, divisionId, ['LARKANA_DIST']).expect(400);
    expect(res.body.error.code).toBe('EXTRA_UNIT_INVALID');
    expect((await put(admin, divisionId, ['NOPE']).expect(400)).body.error.details.codes).toEqual([
      'NOPE',
    ]);
  });

  it('never for a zimmedar', async () => {
    const z = (await User.findOne({ ajeerCode: '9090412' }).lean())!;
    const res = await put(admin, String(z._id), ['LARKANA']).expect(400);
    expect(res.body.error.code).toBe('EXTRA_UNITS_NOT_ALLOWED');
  });

  it('the Admin lists the Divisions to choose from', async () => {
    const res = await request(app)
      .get('/api/v1/users/units?level=division')
      .set('Cookie', admin)
      .expect(200);
    const codes = (res.body.units as { code: string }[]).map((u) => u.code);
    expect(codes).toContain('LARKANA');
    expect(codes).not.toContain('LARKANA_DIST');
  });

  it('given: he sees the second Division, its users and its reports; audited', async () => {
    const res = await put(admin, divisionId, ['LARKANA']).expect(200);
    expect(codes(res.body.extraUnits)).toEqual(['LARKANA']);

    const me = await request(app).get('/api/v1/auth/me').set('Cookie', division).expect(200);
    expect(me.body.user.unit.code).toBe('SUKKUR');
    expect(codes(me.body.user.extraUnits)).toEqual(['LARKANA']);

    const ov = await request(app)
      .get('/api/v1/dash/units/LARKANA/overview?period=day')
      .set('Cookie', division)
      .expect(200);
    // The breadcrumb starts at the extra Division, never above it.
    expect(codes(ov.body.breadcrumb)).toEqual(['LARKANA']);
    await request(app)
      .get('/api/v1/dash/units/LARKANA_DIST/zimmedaran?period=day')
      .set('Cookie', division)
      .expect(200);
    await request(app)
      .get('/api/v1/dash/export.xlsx?view=children&code=LARKANA&period=day')
      .set('Cookie', division)
      .expect(200);
    const users = await request(app)
      .get('/api/v1/users?unit=LARKANA')
      .set('Cookie', division)
      .expect(200);
    expect(users.body.users.length).toBeGreaterThan(0);

    // Still not a third Division, nor the Suba above.
    for (const code of ['HYDERABAD', 'INT_SINDH']) {
      await request(app)
        .get(`/api/v1/dash/units/${code}/overview?period=day`)
        .set('Cookie', division)
        .expect(404);
    }
    // Still view only.
    await request(app)
      .post('/api/v1/villages/manage')
      .set('Cookie', division)
      .send({ name: 'Naya Gaon', districtCode: 'LARKANA_DIST' })
      .expect(403);

    const log = await AuditLog.findOne({ action: 'USER_EXTRA_UNITS' }).lean();
    expect(log?.details).toMatchObject({
      targetAjeerCode: '9030001',
      before: [],
      after: ['LARKANA'],
    });

    const listed = await request(app)
      .get('/api/v1/users?q=9030001')
      .set('Cookie', admin)
      .expect(200);
    expect(listed.body.users[0].extraUnitCodes).toEqual(['LARKANA']);
  });

  it('removed: out of scope again', async () => {
    await put(admin, divisionId, []).expect(200);
    await request(app)
      .get('/api/v1/dash/units/LARKANA/overview?period=day')
      .set('Cookie', division)
      .expect(404);
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', division).expect(200);
    expect(me.body.user.extraUnits).toBeUndefined();
  });
});

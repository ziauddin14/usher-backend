import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { addDays, karachiDate } from '../../lib/time.js';
import { Donor } from '../../models/donor.js';
import { Jadwal } from '../../models/jadwal.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';
import { provisionTestUser, TEST_AJEER_CODE } from './service.js';

// CTO 13 Nov 2026: a test-mode Ushar Zimmedar in the live app — works like any zimmedar, lives in
// the TEST sandbox (outside PK) so nothing he does is counted, and his test data is cleared.
const app = createApp();
const today = karachiDate();
let test: string;
let pakistan: string;
let villageId: string;

const as = (cookie: string) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', cookie),
  post: (url: string, body: object = {}) =>
    request(app).post(`/api/v1${url}`).set('Cookie', cookie).send(body),
});

async function submittedDay(date?: string) {
  const day = await as(test)
    .post('/jadwals', {
      entryType: 'amli',
      travel: { mode: 'bike', meterStart: 10 },
      ...(date ? { date } : {}),
    })
    .expect(201);
  const id = day.body.jadwal.id as string;
  await as(test).post(`/jadwals/${id}/visits`, { villageId }).expect(201);
  await as(test).post(`/jadwals/${id}/submit`, { meterEnd: 20 }).expect(200);
  return id;
}

beforeAll(async () => {
  await seedDemo({ reset: true });
  pakistan = await loginCookie(app, '9010001');
});

describe('test-mode zimmedar', () => {
  it('provisioning: dry run writes nothing; then the sandbox, the account, Gaon and donors', async () => {
    const dry = await provisionTestUser({ dryRun: true, operator: 'cli:test' });
    expect(dry).toMatchObject({ user: 'created', gaon: 3, donors: 9 });
    expect(await User.countDocuments({ ajeerCode: TEST_AJEER_CODE })).toBe(0);

    await provisionTestUser({ dryRun: false, operator: 'cli:test' });
    const u = await User.findOne({ ajeerCode: TEST_AJEER_CODE }).lean();
    expect(u).toMatchObject({ isTest: true, role: 'zimmedar', mustChangePassword: true });
    expect(u!.unitPath).toBe('TEST/TEST_SUBA/TEST_DIV/TEST_DIST');
    expect(await Unit.countDocuments({ path: { $regex: '^TEST' } })).toBe(4);
    expect(await Village.countDocuments({ assignedTo: u!._id })).toBe(3);
    expect(await Donor.countDocuments({ unitPath: { $regex: '^TEST/' } })).toBe(9);
    // Again: nothing doubled, the account is not reset.
    const again = await provisionTestUser({ dryRun: false, operator: 'cli:test' });
    expect(again.user).toBe('exists');
    expect(await Donor.countDocuments({ unitPath: { $regex: '^TEST/' } })).toBe(9);
    villageId = String((await Village.findOne({ assignedTo: u!._id }).lean())!._id);
  });

  it('logs in with the initial password, must change it, then works like any zimmedar', async () => {
    const first = await loginCookie(app, TEST_AJEER_CODE, 'demo1234');
    await as(first).get('/jadwals/today').expect(403);
    await as(first)
      .post('/auth/change-password', { currentPassword: 'demo1234', newPassword: 'test-5678' })
      .expect(200);
    test = await loginCookie(app, TEST_AJEER_CODE, 'test-5678');
    const me = await as(test).get('/auth/me').expect(200);
    expect(me.body.user).toMatchObject({ isTest: true, role: 'zimmedar' });
    const list = await as(test).get(`/villages/${villageId}/donors`).expect(200);
    expect(list.body.donors).toHaveLength(3);
    await submittedDay();
  });

  it('nothing he does is counted: outside every PK report and dashboard', async () => {
    const pk = await as(pakistan).get('/dash/units/PK/overview?period=day').expect(200);
    const users = await User.countDocuments({
      role: 'zimmedar',
      isActive: true,
      unitPath: { $regex: '^PK/' },
    });
    expect(pk.body.tiles.zimmedaran).toBe(users);
    const tasks = await as(pakistan).get('/dash/units/PK/tasks?period=day').expect(200);
    expect(tasks.body.days).toBe(0);
    // The sandbox is out of every real scope.
    await as(pakistan).get('/dash/units/TEST_DIST/overview?period=day').expect(404);
  });

  it('his data is cleared on request; earlier days at login; a real zimmedar may not clear', async () => {
    const real = await loginCookie(app, '9090412');
    await as(real).post('/me/test-reset').expect(403);

    await Jadwal.deleteMany({ ajeerCode: TEST_AJEER_CODE });
    await submittedDay(addDays(today, -1));
    await submittedDay();
    expect(await Jadwal.countDocuments({ ajeerCode: TEST_AJEER_CODE })).toBe(2);
    // A new login clears the days before today only.
    test = await loginCookie(app, TEST_AJEER_CODE, 'test-5678');
    const left = await Jadwal.find({ ajeerCode: TEST_AJEER_CODE }).lean();
    expect(left.map((j) => j.date)).toEqual([today]);

    const res = await as(test).post('/me/test-reset').expect(200);
    expect(res.body.jadwals).toBe(1);
    expect(await Jadwal.countDocuments({ ajeerCode: TEST_AJEER_CODE })).toBe(0);
  });

  it('the national unit is always PK, never the sandbox root', async () => {
    expect(await Unit.countDocuments({ level: 'pakistan' })).toBe(2);
    expect((await Unit.findOne({ code: 'PK', level: 'pakistan' }).lean())!.path).toBe('PK');
  });
});

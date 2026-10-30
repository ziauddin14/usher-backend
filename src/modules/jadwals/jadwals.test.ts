import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { addDays, karachiDate } from '../../lib/time.js';
import { AuditLog } from '../../models/audit-log.js';
import { Jadwal } from '../../models/jadwal.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';

const app = createApp();
const today = karachiDate();

let arif: string; // 90412, Ghotki
let other: string; // another Ghotki zimmedar
let district: string; // 40001 Ghotki
let larkanaDistrict: string;
let villageIds: string[];

const api = (cookie: string) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', cookie),
  post: (url: string, body: object = {}) =>
    request(app).post(`/api/v1${url}`).set('Cookie', cookie).send(body),
  put: (url: string, body: object) =>
    request(app).put(`/api/v1${url}`).set('Cookie', cookie).send(body),
  patch: (url: string, body: object) =>
    request(app).patch(`/api/v1${url}`).set('Cookie', cookie).send(body),
  del: (url: string) => request(app).delete(`/api/v1${url}`).set('Cookie', cookie),
});

async function startBikeDay(cookie: string, meterStart = 48214, date?: string): Promise<string> {
  const res = await api(cookie)
    .post('/jadwals', {
      entryType: 'amli',
      travel: { mode: 'bike', meterStart },
      ...(date ? { date } : {}),
    })
    .expect(201);
  return res.body.jadwal.id as string;
}

beforeAll(async () => {
  await seedDemo({ reset: true });
  await User.create({
    ajeerCode: '40002',
    name: 'Test Larkana District',
    role: 'district',
    unitCode: 'LARKANA_DIST',
    unitPath: 'PK/INT_SINDH/LARKANA/LARKANA_DIST',
    passwordHash: await bcrypt.hash('demo1234', 4),
    mustChangePassword: false,
  });
  const otherUser = await User.findOne({
    role: 'zimmedar',
    unitCode: 'GHOTKI',
    ajeerCode: { $ne: '90412' },
  }).lean();
  arif = await loginCookie(app, '90412');
  other = await loginCookie(app, otherUser!.ajeerCode);
  district = await loginCookie(app, '40001');
  larkanaDistrict = await loginCookie(app, '40002');
  villageIds = (await Village.find({ districtCode: 'GHOTKI' }).sort({ nameKey: 1 }).lean()).map(
    (v) => String(v._id),
  );
});

beforeEach(async () => {
  await Jadwal.deleteMany({});
});

describe('starting a day', () => {
  it('creates a draft amli jadwal for today with the server start time', async () => {
    const res = await api(arif)
      .post('/jadwals', { entryType: 'amli', travel: { mode: 'bike', meterStart: 100 } })
      .expect(201);
    expect(res.body.jadwal).toMatchObject({
      date: today,
      status: 'draft',
      entryType: 'amli',
      travel: { mode: 'bike', meterStart: 100 },
    });
    expect(res.body.jadwal.startedAt).toBeTruthy();
  });

  it('one jadwal per user per date → 409', async () => {
    await startBikeDay(arif);
    const res = await api(arif).post('/jadwals', { entryType: 'rukhsat' }).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('date window: back-dating up to backdateDays, never the future', async () => {
    await api(arif)
      .post('/jadwals', { entryType: 'rukhsat', date: addDays(today, -3) })
      .expect(201);
    const old = await api(arif)
      .post('/jadwals', { entryType: 'rukhsat', date: addDays(today, -4) })
      .expect(400);
    expect(old.body.error.details.reason).toBe('DATE_OUT_OF_RANGE');
    await api(arif)
      .post('/jadwals', { entryType: 'rukhsat', date: addDays(today, 1) })
      .expect(400);
  });

  it('non-amli types are created already submitted, with zero totals', async () => {
    const res = await api(arif)
      .post('/jadwals', { entryType: 'qafila', note: 'قافلہ' })
      .expect(201);
    expect(res.body.jadwal).toMatchObject({
      status: 'submitted',
      entryType: 'qafila',
      totals: { villages: 0, wusooli: 0 },
    });
    expect(
      await AuditLog.countDocuments({ action: 'JADWAL_SUBMIT', targetId: res.body.jadwal.id }),
    ).toBe(1);
  });

  it('amli needs travel: bike meter start or bus fare (0 allowed)', async () => {
    await api(arif).post('/jadwals', { entryType: 'amli' }).expect(400);
    await api(arif)
      .post('/jadwals', { entryType: 'amli', travel: { mode: 'bike' } })
      .expect(400);
    await api(arif)
      .post('/jadwals', { entryType: 'amli', travel: { mode: 'bus', fare: 0 } })
      .expect(201);
  });

  it('GET /jadwals/today returns the draft and the last bike meter end', async () => {
    const id = await startBikeDay(arif, 1000, addDays(today, -1));
    const villageId = villageIds[0]!;
    await api(arif).post(`/jadwals/${id}/visits`, { villageId }).expect(201);
    await api(arif).post(`/jadwals/${id}/submit`, { meterEnd: 1062 }).expect(200);

    const res = await api(arif).get('/jadwals/today').expect(200);
    expect(res.body).toMatchObject({ today, jadwal: null, lastMeterEnd: 1062 });
  });
});

describe('villages and visits', () => {
  it('lists district villages, most recently visited first', async () => {
    const res = await api(arif).get('/villages').expect(200);
    expect(res.body.villages).toHaveLength(villageIds.length);
    expect(res.body.villages[0]).toMatchObject({ status: 'approved', lastVisitDate: null });
  });

  it('adds a pending village usable by the adder only; duplicate name → 409 VILLAGE_EXISTS', async () => {
    const added = await api(arif).post('/villages', { name: 'گوٹھ   مکھن شاہ' }).expect(201);
    expect(added.body.village).toMatchObject({ name: 'گوٹھ مکھن شاہ', status: 'pending' });
    const dup = await api(other).post('/villages', { name: 'مکھن شاہ' }).expect(409);
    expect(dup.body.error.code).toBe('VILLAGE_EXISTS');

    const otherDay = await startBikeDay(other);
    await api(other)
      .post(`/jadwals/${otherDay}/visits`, { villageId: added.body.village.id })
      .expect(404);
    const myDay = await startBikeDay(arif);
    await api(arif)
      .post(`/jadwals/${myDay}/visits`, { villageId: added.body.village.id })
      .expect(201);
  });

  it('the same village twice in one jadwal → 409', async () => {
    const id = await startBikeDay(arif);
    await api(arif).post(`/jadwals/${id}/visits`, { villageId: villageIds[0] }).expect(201);
    const res = await api(arif)
      .post(`/jadwals/${id}/visits`, { villageId: villageIds[0] })
      .expect(409);
    expect(res.body.error.details.reason).toBe('VILLAGE_ALREADY_ADDED');
  });

  it('a village of another district cannot be used (404)', async () => {
    const larkana = await Village.findOne({ districtCode: 'LARKANA_DIST' }).lean();
    const id = await startBikeDay(arif);
    await api(arif)
      .post(`/jadwals/${id}/visits`, { villageId: String(larkana!._id) })
      .expect(404);
  });

  it('a visit can be removed only while nothing is saved in it', async () => {
    const id = await startBikeDay(arif);
    const jadwal = (await api(arif).post(`/jadwals/${id}/visits`, { villageId: villageIds[0] }))
      .body.jadwal;
    const visitId = jadwal.visits[0].id as string;
    await api(arif)
      .put(`/jadwals/${id}/visits/${visitId}/donors`, { oldMet: 1, newDonors: [] })
      .expect(200);
    await api(arif).del(`/jadwals/${id}/visits/${visitId}`).expect(409);
  });
});

describe('village tasks', () => {
  let id: string;
  let visitId: string;
  beforeEach(async () => {
    id = await startBikeDay(arif);
    visitId = (await api(arif).post(`/jadwals/${id}/visits`, { villageId: villageIds[1] })).body
      .jadwal.visits[0].id;
  });
  const put = (step: string, body: object) =>
    api(arif).put(`/jadwals/${id}/visits/${visitId}/${step}`, body);

  it('saves donors and marks the step', async () => {
    const res = await put('donors', {
      oldMet: 4,
      newDonors: [{ name: 'علی نواز', mobile: '0300 0000000', acres: 12 }],
    }).expect(200);
    expect(res.body.savedSteps).toEqual(['donors']);
    expect(res.body.visit.donors.newDonors[0]).toMatchObject({ mobile: '03000000000', acres: 12 });
    await put('donors', { oldMet: 0, newDonors: [{ name: 'x', mobile: '12345' }] }).expect(400);
  });

  it('atiyat: category id must exist in settings', async () => {
    const res = await put('atiyat', {
      entries: [{ type: 'wusooli', category: 'nope', kind: 'naqd', amount: 100 }],
    }).expect(400);
    expect(res.body.error.details.reason).toBe('UNKNOWN_CATEGORY');
  });

  it('atiyat: GSB only as wusooli', async () => {
    const res = await put('atiyat', {
      entries: [{ type: 'niyyat', category: 'gsb', kind: 'naqd', amount: 100 }],
    }).expect(400);
    expect(res.body.error.details.reason).toBe('GSB_ONLY_WUSOOLI');
  });

  it('atiyat: integer rupees only', async () => {
    await put('atiyat', {
      entries: [{ type: 'wusooli', category: 'ushr', kind: 'naqd', amount: 10.5 }],
    }).expect(400);
  });

  it('ijtima / mashwara: participants required when held; empty when not', async () => {
    await put('ijtima', { held: true, type: 'kisan' }).expect(400);
    await put('ijtima', { held: true, type: 'kisan', participants: 18 }).expect(200);
    const no = await put('mashwara', { held: false, participants: 9 }).expect(200);
    expect(no.body.visit.mashwara).toEqual({ held: false });
    expect(no.body.savedSteps).toEqual(['ijtima', 'mashwara']);
  });
});

describe('submit, lock and reopen', () => {
  async function fullDay(): Promise<string> {
    const id = await startBikeDay(arif, 48214);
    const visitId = (await api(arif).post(`/jadwals/${id}/visits`, { villageId: villageIds[2] }))
      .body.jadwal.visits[0].id;
    const base = `/jadwals/${id}/visits/${visitId}`;
    await api(arif)
      .put(`${base}/donors`, { oldMet: 4, newDonors: [{ name: 'علی نواز' }] })
      .expect(200);
    await api(arif)
      .put(`${base}/atiyat`, {
        entries: [
          { type: 'wusooli', category: 'ushr', kind: 'jins', amount: 3000, detail: 'گندم 2 من' },
          { type: 'wusooli', category: 'mahana', kind: 'naqd', amount: 1500 },
          { type: 'wusooli', category: 'tameer', kind: 'naqd', amount: 1000 },
          { type: 'niyyat', category: 'ushr', kind: 'jins', amount: 25000 },
        ],
        gsb: { boxesOpened: 2, amount: 2000 },
      })
      .expect(200);
    await api(arif)
      .put(`${base}/ijtima`, { held: true, type: 'kisan', participants: 18 })
      .expect(200);
    await api(arif).put(`${base}/mashwara`, { held: true, participants: 3 }).expect(200);
    return id;
  }

  it('amli needs at least one village; meter end must be ≥ meter start', async () => {
    const empty = await startBikeDay(arif);
    expect(
      (await api(arif).post(`/jadwals/${empty}/submit`, { meterEnd: 48300 }).expect(400)).body.error
        .details.reason,
    ).toBe('NO_VISITS');
    await Jadwal.deleteMany({});
    const id = await fullDay();
    expect(
      (await api(arif).post(`/jadwals/${id}/submit`, { meterEnd: 48000 }).expect(400)).body.error
        .details.reason,
    ).toBe('METER_END_BEFORE_START');
  });

  it('computes totals on submit (reward excludes tameer) and audits', async () => {
    const id = await fullDay();
    const res = await api(arif)
      .post(`/jadwals/${id}/submit`, { meterEnd: 48276, note: 'ٹھیک دن' })
      .expect(200);
    expect(res.body.jadwal).toMatchObject({
      status: 'submitted',
      travel: { meterEnd: 48276, km: 62 },
      totals: {
        villages: 1,
        oldDonors: 4,
        newDonors: 1,
        niyyat: 25000,
        wusooli: 7500,
        rewardWusooli: 6500,
        excludedWusooli: 1000,
        gsbBoxes: 2,
        ijtimas: 1,
        mashwaras: 1,
        km: 62,
      },
    });
    expect(await AuditLog.countDocuments({ action: 'JADWAL_SUBMIT', targetId: id })).toBe(1);
  });

  it('no writes after submit → 409 JADWAL_LOCKED', async () => {
    const id = await fullDay();
    await api(arif).post(`/jadwals/${id}/submit`, { meterEnd: 48276 }).expect(200);
    const res = await api(arif)
      .post(`/jadwals/${id}/visits`, { villageId: villageIds[3] })
      .expect(409);
    expect(res.body.error.code).toBe('JADWAL_LOCKED');
    await api(arif).patch(`/jadwals/${id}`, { note: 'x' }).expect(409);
    await api(arif).post(`/jadwals/${id}/submit`, { meterEnd: 48300 }).expect(409);
  });

  it('a zimmedar cannot read or write another zimmedar’s jadwal (404)', async () => {
    const id = await fullDay();
    await api(other).get(`/jadwals/${id}`).expect(404);
    await api(other).patch(`/jadwals/${id}`, { note: 'x' }).expect(404);
    await api(other).post(`/jadwals/${id}/submit`, { meterEnd: 48300 }).expect(404);
    await api(arif).get(`/jadwals/${id}`).expect(200);
  });

  it('reopen: district in scope with a reason (audited); zimmedar 403; other district 404', async () => {
    const id = await fullDay();
    await api(arif).post(`/jadwals/${id}/submit`, { meterEnd: 48276 }).expect(200);

    await api(arif).post(`/jadwals/${id}/reopen`, { reason: 'ghalti hui' }).expect(403);
    await api(larkanaDistrict).post(`/jadwals/${id}/reopen`, { reason: 'ghalti hui' }).expect(404);
    await api(district).post(`/jadwals/${id}/reopen`, { reason: 'abc' }).expect(400);

    const res = await api(district)
      .post(`/jadwals/${id}/reopen`, { reason: 'Meter reading ghalat' })
      .expect(200);
    expect(res.body.jadwal).toMatchObject({
      status: 'draft',
      reopened: [{ reason: 'Meter reading ghalat' }],
    });
    expect(await AuditLog.countDocuments({ action: 'JADWAL_REOPEN', targetId: id })).toBe(1);

    // The zimmedar can fix and submit again.
    await api(arif).post(`/jadwals/${id}/submit`, { meterEnd: 48280 }).expect(200);
    await api(district).get(`/jadwals/${id}`).expect(200);
  });
});

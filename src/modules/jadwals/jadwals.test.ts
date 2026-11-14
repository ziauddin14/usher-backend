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

let arif: string; // 9090412, Ghotki
let other: string; // another Ghotki zimmedar
let district: string; // 9040001 Ghotki
let admin: string; // 9100001 — the only role that changes data (CTO 14 Nov 2026)
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
    ajeerCode: { $ne: '9090412' },
  }).lean();
  arif = await loginCookie(app, '9090412');
  other = await loginCookie(app, otherUser!.ajeerCode);
  district = await loginCookie(app, '9040001');
  larkanaDistrict = await loginCookie(app, '40002');
  admin = await loginCookie(app, '9100001');
  // The demo zimmedar uses only the villages assigned to them (CTO 7 Nov 2026).
  const arifId = (await User.findOne({ ajeerCode: '9090412' }).lean())!._id;
  villageIds = (
    await Village.find({ districtCode: 'GHOTKI', assignedTo: arifId }).sort({ nameKey: 1 }).lean()
  ).map((v) => String(v._id));
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

  it('back-dated day next to today: listed on /today as an open draft, audited as back-dated', async () => {
    await startBikeDay(arif, 100); // today
    const back = await startBikeDay(arif, 50, addDays(today, -2));
    // The same earlier date twice → 409.
    await api(arif)
      .post('/jadwals', { entryType: 'rukhsat', date: addDays(today, -2) })
      .expect(409);

    const t = await api(arif).get('/jadwals/today').expect(200);
    expect(t.body.jadwal.date).toBe(today);
    expect(t.body.otherDrafts).toEqual([{ id: back, date: addDays(today, -2), villages: 0 }]);
    // Another zimmedar never sees them.
    expect((await api(other).get('/jadwals/today').expect(200)).body.otherDrafts).toEqual([]);

    await api(arif).post(`/jadwals/${back}/visits`, { villageId: villageIds[0] }).expect(201);
    const done = await api(arif).post(`/jadwals/${back}/submit`, { meterEnd: 80 }).expect(200);
    expect(done.body.jadwal).toMatchObject({ date: addDays(today, -2), status: 'submitted' });
    expect(
      await AuditLog.findOne({ action: 'JADWAL_SUBMIT', targetId: back }).lean(),
    ).toMatchObject({ details: { date: addDays(today, -2), backdated: true } });
    expect((await api(arif).get('/jadwals/today').expect(200)).body.otherDrafts).toEqual([]);
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

  it('amli needs travel: bike meter start, or bus (fare not asked at the start)', async () => {
    await api(arif).post('/jadwals', { entryType: 'amli' }).expect(400);
    await api(arif)
      .post('/jadwals', { entryType: 'amli', travel: { mode: 'bike' } })
      .expect(400);
    await api(arif)
      .post('/jadwals', { entryType: 'amli', travel: { mode: 'bus' } })
      .expect(201);
  });

  it('bus fare is entered when the day ends (CTO 11 Nov 2026); 0 allowed, missing = 400', async () => {
    const start = await api(arif)
      .post('/jadwals', { entryType: 'amli', travel: { mode: 'bus' } })
      .expect(201);
    const id = start.body.jadwal.id as string;
    await api(arif).post(`/jadwals/${id}/visits`, { villageId: villageIds[0]! }).expect(201);
    const missing = await api(arif).post(`/jadwals/${id}/submit`, {}).expect(400);
    expect(missing.body.error.details.reason).toBe('FARE_REQUIRED');
    await api(arif).post(`/jadwals/${id}/submit`, { fare: -5 }).expect(400);
    const done = await api(arif).post(`/jadwals/${id}/submit`, { fare: 350 }).expect(200);
    expect(done.body.jadwal.travel).toMatchObject({ mode: 'bus', fare: 350 });
    expect(done.body.jadwal.totals.fare).toBe(350);
  });

  it('a fare sent at the start (older app) is kept when none is sent at the end', async () => {
    const start = await api(arif)
      .post('/jadwals', { entryType: 'amli', travel: { mode: 'bus', fare: 0 } })
      .expect(201);
    const id = start.body.jadwal.id as string;
    await api(arif).post(`/jadwals/${id}/visits`, { villageId: villageIds[0]! }).expect(201);
    const done = await api(arif).post(`/jadwals/${id}/submit`, {}).expect(200);
    expect(done.body.jadwal.totals.fare).toBe(0);
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
  it('lists only the villages assigned to the zimmedar — with or without a search (CTO 7 Nov)', async () => {
    const mine = (await api(arif).get('/villages').expect(200)).body.villages as {
      mine: boolean;
    }[];
    expect(mine).toHaveLength(5); // seed: the demo zimmedar has 5 villages
    expect(mine.every((v) => v.mine)).toBe(true);

    const found = (
      await api(arif)
        .get('/villages?q=' + encodeURIComponent('گوٹھ'))
        .expect(200)
    ).body.villages as { mine: boolean }[];
    expect(found).toHaveLength(5);
    expect(found.every((v) => v.mine)).toBe(true);
    const inDistrict = await Village.countDocuments({ districtCode: 'GHOTKI' });
    expect(inDistrict).toBeGreaterThan(5); // other villages exist but are never offered
  });

  it('another zimmedar’s village cannot be listed or put in a jadwal (404)', async () => {
    const othersVillage = await Village.findOne({
      districtCode: 'GHOTKI',
      assignedTo: { $exists: true },
      _id: { $nin: villageIds },
    }).lean();
    const day = await startBikeDay(arif);
    await api(arif)
      .post(`/jadwals/${day}/visits`, { villageId: String(othersVillage!._id) })
      .expect(404);
  });

  it('a "district pool" village (no zimmedar) is not offered to or usable by any zimmedar until the District assigns it', async () => {
    await Village.create({
      name: 'گوٹھ پول',
      nameKey: 'پول',
      districtCode: 'GHOTKI',
      unitPath: 'PK/INT_SINDH/SUKKUR/GHOTKI',
      status: 'approved',
    });
    for (const cookie of [arif, other]) {
      const mine = (await api(cookie).get('/villages').expect(200)).body.villages as {
        name: string;
      }[];
      expect(mine.some((v) => v.name === 'گوٹھ پول')).toBe(false);
      const found = (
        await api(cookie)
          .get('/villages?q=' + encodeURIComponent('پول'))
          .expect(200)
      ).body.villages as { name: string; mine: boolean }[];
      expect(found).toEqual([]);
    }
    const pool = await Village.findOne({ nameKey: 'پول' }).lean();
    const day = await startBikeDay(arif);
    await api(arif)
      .post(`/jadwals/${day}/visits`, { villageId: String(pool!._id) })
      .expect(404);
    // Adding the same name does not hand it over either: 409 with mine=false.
    const dup = await api(arif).post('/villages', { name: 'گوٹھ پول' }).expect(409);
    expect(dup.body.error.details.village).toMatchObject({ name: 'گوٹھ پول', mine: false });
    // Once the District assigns it, it is listed and usable.
    const arifId = String((await User.findOne({ ajeerCode: '9090412' }).lean())!._id);
    await api(admin)
      .post(`/villages/${String(pool!._id)}/assign`, { userId: arifId })
      .expect(200);
    const after = (await api(arif).get('/villages').expect(200)).body.villages as {
      name: string;
    }[];
    expect(after.some((v) => v.name === 'گوٹھ پول')).toBe(true);
    await api(arif)
      .post(`/jadwals/${day}/visits`, { villageId: String(pool!._id) })
      .expect(201);
    await Jadwal.deleteMany({});
    await Village.deleteOne({ nameKey: 'پول' }); // test-only cleanup of the invented village
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

  it('atiyat: wusooli without a mad — the naqd total and jins items (CTO 13 Nov 2026)', async () => {
    const res = await put('atiyat', {
      entries: [
        { type: 'wusooli', kind: 'naqd', amount: 50000 },
        { type: 'wusooli', kind: 'jins', amount: 0, detail: 'گندم', qty: 40, unit: 'من' },
      ],
    }).expect(200);
    expect(res.body.visit.atiyat.entries[1]).toMatchObject({ detail: 'گندم', qty: 40, unit: 'من' });
    // Jins needs what and how much; naqd at least Rs 1; niyyat still needs its mad.
    await put('atiyat', {
      entries: [{ type: 'wusooli', kind: 'jins', amount: 100, detail: 'گندم' }],
    }).expect(400);
    await put('atiyat', { entries: [{ type: 'wusooli', kind: 'naqd', amount: 0 }] }).expect(400);
    await put('atiyat', { entries: [{ type: 'niyyat', kind: 'naqd', amount: 100 }] }).expect(400);
    await put('atiyat', {
      entries: [{ type: 'wusooli', kind: 'naqd', amount: 100, qty: 2 }],
    }).expect(400);
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

  it('reopen: the Admin with a reason (audited); zimmedar and District 403 (CTO 14 Nov 2026)', async () => {
    const id = await fullDay();
    await api(arif).post(`/jadwals/${id}/submit`, { meterEnd: 48276 }).expect(200);

    await api(arif).post(`/jadwals/${id}/reopen`, { reason: 'ghalti hui' }).expect(403);
    await api(larkanaDistrict).post(`/jadwals/${id}/reopen`, { reason: 'ghalti hui' }).expect(403);
    await api(district).post(`/jadwals/${id}/reopen`, { reason: 'ghalti hui' }).expect(403);
    await api(admin).post(`/jadwals/${id}/reopen`, { reason: 'abc' }).expect(400);

    const res = await api(admin)
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

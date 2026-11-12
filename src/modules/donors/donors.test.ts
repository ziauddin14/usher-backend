import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { addDays, karachiDate } from '../../lib/time.js';
import { Donor } from '../../models/donor.js';
import { Jadwal } from '../../models/jadwal.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';

// CTO 12 Nov 2026: the Gaon's old donors with their last meeting; ticking the ones met (with the
// tasks); on submit the meeting is recorded and the day's new donors join the list the next day,
// marked new until met again. Invented data.
const app = createApp();
const today = karachiDate();
let arif: string; // 9090412
let other: string; // another Ghotki zimmedar
let villageId: string;
let donorA: string;
let donorB: string;

const as = (cookie: string) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', cookie),
  post: (url: string, body: object = {}) =>
    request(app).post(`/api/v1${url}`).set('Cookie', cookie).send(body),
  put: (url: string, body: object) =>
    request(app).put(`/api/v1${url}`).set('Cookie', cookie).send(body),
});

async function dayWithVisit(date?: string) {
  const day = await as(arif)
    .post('/jadwals', {
      entryType: 'amli',
      travel: { mode: 'bike', meterStart: 100 },
      ...(date ? { date } : {}),
    })
    .expect(201);
  const id = day.body.jadwal.id as string;
  const v = await as(arif).post(`/jadwals/${id}/visits`, { villageId }).expect(201);
  return { id, visitId: v.body.jadwal.visits[0].id as string };
}

beforeAll(async () => {
  await seedDemo({ reset: true });
  await Donor.deleteMany({}); // only this test's donors below
  arif = await loginCookie(app, '9090412');
  const me = await User.findOne({ ajeerCode: '9090412' }).lean();
  const otherUser = await User.findOne({
    role: 'zimmedar',
    unitCode: 'GHOTKI',
    ajeerCode: { $ne: '9090412' },
  }).lean();
  other = await loginCookie(app, otherUser!.ajeerCode);
  const v = await Village.findOne({ assignedTo: me!._id }).lean();
  villageId = String(v!._id);
  await Village.updateOne(
    { _id: v!._id },
    { $set: { localZimmedar: { name: 'مقامی', mobile: '03001111111' } } },
  );
  const base = {
    villageId: v!._id,
    unitPath: v!.unitPath,
    addedOn: today,
    source: { kind: 'import' as const, file: 'donors.csv', at: new Date() },
    meetings: 0,
    isActive: true,
  };
  const [a, b] = await Donor.create([
    { ...base, name: 'ڈونر الف', nameKey: 'ڈونر الف', mobile: '03002222222', acres: 10 },
    { ...base, name: 'ڈونر ب', nameKey: 'ڈونر ب' },
  ]);
  donorA = String(a!._id);
  donorB = String(b!._id);
});

beforeEach(async () => {
  await Jadwal.deleteMany({});
});

describe('donors of a Gaon', () => {
  it('lists imported donors and the local zimmedar, only for the Gaon’s own zimmedar', async () => {
    const res = await as(arif).get(`/villages/${villageId}/donors`).expect(200);
    expect(res.body.village.localZimmedar).toEqual({ name: 'مقامی', mobile: '03001111111' });
    expect(res.body.donors).toHaveLength(2);
    expect(res.body.donors[0]).toMatchObject({
      name: 'ڈونر الف',
      mobile: '03002222222',
      isNew: false,
      lastMet: null,
    });
    await as(other).get(`/villages/${villageId}/donors`).expect(404);
  });

  it('ticked donors: checked against the Gaon, recorded on submit with their tasks', async () => {
    const { id, visitId } = await dayWithVisit();
    const url = `/jadwals/${id}/visits/${visitId}/donors`;
    const bad = await as(arif)
      .put(url, { oldMet: 0, newDonors: [], met: [{ donorId: '0123456789abcdef01234567' }] })
      .expect(400);
    expect(bad.body.error.details.reason).toBe('DONOR_NOT_IN_VILLAGE');
    await as(arif)
      .put(url, { oldMet: 0, newDonors: [], met: [{ donorId: donorA }, { donorId: donorA }] })
      .expect(400);

    const saved = await as(arif)
      .put(url, {
        oldMet: 9, // replaced by the number of ticked donors
        met: [{ donorId: donorA, tasks: [{ id: 'toray', count: 5 }] }],
        newDonors: [{ name: 'نیا ڈونر', mobile: '03004444444' }],
      })
      .expect(200);
    expect(saved.body.visit.donors.oldMet).toBe(1);
    // Nothing is recorded on the donor before the day is submitted.
    expect((await Donor.findById(donorA).lean())!.lastMet).toBeUndefined();

    await as(arif).post(`/jadwals/${id}/submit`, { meterEnd: 120 }).expect(200);
    expect(await Donor.findById(donorA).lean()).toMatchObject({
      meetings: 1,
      lastMet: { date: today, tasks: [{ id: 'toray', count: 5 }] },
    });
    const added = await Donor.findOne({ mobile: '03004444444' }).lean();
    expect(added).toMatchObject({ addedOn: today, meetings: 0, source: { kind: 'zimmedar' } });

    // Today: the new donor is not yet an old donor; tomorrow it is, marked new.
    const now = await as(arif).get(`/villages/${villageId}/donors`).expect(200);
    expect((now.body.donors as { name: string }[]).map((d) => d.name)).not.toContain('نیا ڈونر');
    const next = await as(arif)
      .get(`/villages/${villageId}/donors?date=${addDays(today, 1)}`)
      .expect(200);
    const nw = (next.body.donors as { name: string; isNew: boolean }[]).find(
      (d) => d.name === 'نیا ڈونر',
    );
    expect(nw?.isNew).toBe(true);
    const a = (next.body.donors as { id: string; lastMet: unknown }[]).find((d) => d.id === donorA);
    expect(a?.lastMet).toEqual({ date: today, tasks: [{ id: 'toray', count: 5 }] });
  });

  it('a back-dated meeting never replaces a later last meeting', async () => {
    await Donor.updateOne(
      { _id: donorB },
      { $set: { lastMet: { date: today, jadwalId: donorB, tasks: [{ id: 'gsb' }] } } },
    );
    const { id, visitId } = await dayWithVisit(addDays(today, -1));
    await as(arif)
      .put(`/jadwals/${id}/visits/${visitId}/donors`, {
        oldMet: 0,
        newDonors: [],
        met: [{ donorId: donorB, tasks: [{ id: 'deeni_dawat' }] }],
      })
      .expect(200);
    await as(arif).post(`/jadwals/${id}/submit`, { meterEnd: 120 }).expect(200);
    expect(await Donor.findById(donorB).lean()).toMatchObject({
      meetings: 1,
      lastMet: { date: today, tasks: [{ id: 'gsb' }] },
    });
  });
});

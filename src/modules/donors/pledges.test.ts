import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { addDays, karachiDate } from '../../lib/time.js';
import { Donor } from '../../models/donor.js';
import { Jadwal } from '../../models/jadwal.js';
import { Pledge } from '../../models/pledge.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';

// CTO 13 Nov 2026: niyyat per donor — عشر / عطیہ, naqd or jins, the month it is expected; open
// niyyat shown with the donor; closed with "وصول ہو گئی"; reports. Invented data.
const app = createApp();
const today = karachiDate();
const yesterday = addDays(today, -1);
let arif: string; // 9090412
let district: string; // 9040001 Ghotki
let villageId: string;
let donorA: string;

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
  return { id, base: `/jadwals/${id}/visits/${v.body.jadwal.visits[0].id as string}` };
}

beforeAll(async () => {
  await seedDemo({ reset: true });
  await Donor.deleteMany({});
  await Jadwal.deleteMany({});
  arif = await loginCookie(app, '9090412');
  district = await loginCookie(app, '9040001');
  const me = await User.findOne({ ajeerCode: '9090412' }).lean();
  const v = await Village.findOne({ assignedTo: me!._id }).lean();
  villageId = String(v!._id);
  const d = await Donor.create({
    villageId: v!._id,
    unitPath: v!.unitPath,
    name: 'ڈونر الف',
    nameKey: 'ڈونر الف',
    mobile: '03002222222',
    addedOn: '2026-01-01',
    source: { kind: 'import' as const, file: 'donors.csv', at: new Date() },
    meetings: 0,
    isActive: true,
  });
  donorA = String(d._id);
});

describe('niyyat per donor', () => {
  let pledgeA: string;

  it('written for an old donor and a new donor; checked; saved as open pledges on submit', async () => {
    const { id, base } = await dayWithVisit(yesterday);
    await as(arif)
      .put(`${base}/donors`, {
        oldMet: 1,
        met: [{ donorId: donorA, tasks: [{ id: 'toray', count: 12 }] }],
        newDonors: [{ name: 'نیا ڈونر', mobile: '03004444444' }],
      })
      .expect(200);
    const ushr = {
      type: 'niyyat',
      niyyatType: 'ushr',
      kind: 'jins',
      amount: 0,
      detail: 'گندم',
      qty: 12,
      unit: 'بوری',
      dueMonth: '2027-04',
      donorId: donorA,
    };
    const atiya = {
      type: 'niyyat',
      niyyatType: 'atiya',
      kind: 'naqd',
      amount: 5000,
      dueMonth: '2026-12',
      newDonorName: 'نیا ڈونر',
    };
    // A niyyat needs its donor, type and month; a new donor must be one of this visit.
    await as(arif)
      .put(`${base}/atiyat`, { entries: [{ ...atiya, dueMonth: undefined }] })
      .expect(400);
    const unknown = await as(arif)
      .put(`${base}/atiyat`, { entries: [{ ...atiya, newDonorName: 'کوئی اور' }] })
      .expect(400);
    expect(unknown.body.error.details.reason).toBe('NEW_DONOR_UNKNOWN');
    await as(arif)
      .put(`${base}/atiyat`, { entries: [{ ...ushr, donorId: '0123456789abcdef01234567' }] })
      .expect(400);

    await as(arif)
      .put(`${base}/atiyat`, { entries: [ushr, atiya] })
      .expect(200);
    expect(await Pledge.countDocuments()).toBe(0); // only on submit
    await as(arif).post(`/jadwals/${id}/submit`, { meterEnd: 110 }).expect(200);

    const pledges = await Pledge.find().sort({ entry: 1 }).lean();
    expect(pledges).toHaveLength(2);
    expect(pledges[0]).toMatchObject({
      status: 'open',
      niyyatType: 'ushr',
      kind: 'jins',
      item: 'گندم',
      qty: 12,
      unit: 'بوری',
      dueMonth: '2027-04',
      date: yesterday,
    });
    expect(String(pledges[0]!.donorId)).toBe(donorA);
    const nw = await Donor.findOne({ mobile: '03004444444' }).lean();
    expect(String(pledges[1]!.donorId)).toBe(String(nw!._id)); // the new donor just added
    pledgeA = String(pledges[0]!._id);

    // Today the old donor shows his open niyyat.
    const list = await as(arif).get(`/villages/${villageId}/donors`).expect(200);
    const a = (list.body.donors as { id: string; openPledges: unknown[] }[]).find(
      (x) => x.id === donorA,
    );
    expect(a!.openPledges).toEqual([
      expect.objectContaining({ id: pledgeA, niyyatType: 'ushr', qty: 12, dueMonth: '2027-04' }),
    ]);
  });

  it('"وصول ہو گئی": closed when the donor is met and it is ticked; only his open niyyat', async () => {
    const { id, base } = await dayWithVisit();
    const wrong = await as(arif)
      .put(`${base}/donors`, {
        oldMet: 1,
        met: [{ donorId: donorA, closePledges: ['0123456789abcdef01234567'] }],
        newDonors: [],
      })
      .expect(400);
    expect(wrong.body.error.details.reason).toBe('PLEDGE_NOT_OPEN');
    await as(arif)
      .put(`${base}/donors`, {
        oldMet: 1,
        met: [{ donorId: donorA, closePledges: [pledgeA] }],
        newDonors: [],
      })
      .expect(200);
    await as(arif).post(`/jadwals/${id}/submit`, { meterEnd: 120 }).expect(200);
    expect(await Pledge.findById(pledgeA).lean()).toMatchObject({
      status: 'received',
      received: { date: today },
    });
  });

  it('reports: open now (by type, by month), written and received in the period', async () => {
    const own = await as(arif).get('/me/pledges?period=month').expect(200);
    expect(own.body.open).toMatchObject({
      count: 1,
      naqd: 5000,
      atiya: { count: 1, naqd: 5000 },
      ushr: { count: 0 },
      byMonth: [{ month: '2026-12', count: 1, naqd: 5000 }],
    });
    expect(own.body.received).toMatchObject({
      count: 1,
      jins: [{ item: 'گندم', unit: 'بوری', qty: 12 }],
    });
    expect(own.body.made.count).toBe(2);
    const unit = await as(district).get('/dash/units/GHOTKI/pledges?period=month').expect(200);
    expect(unit.body.open.count).toBe(1);
    expect(unit.body.received.count).toBe(1);
  });
});

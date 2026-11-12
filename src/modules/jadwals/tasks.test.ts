import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { Jadwal } from '../../models/jadwal.js';
import { Setting } from '../../models/setting.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { clearSettingsCache } from '../../lib/settings.js';
import { seedDemo } from '../../seed/seed.js';
import { DEFAULT_DONOR_TASKS } from '../settings/donor-tasks.js';

// CTO 12 Nov 2026: what was done with each donor (multi-select from settings.donorTasks), and a
// day without any Gaon when it had other work instead.
const app = createApp();
let arif: string; // 9090412
let villageId: string;

const post = (url: string, body: object = {}) =>
  request(app).post(`/api/v1${url}`).set('Cookie', arif).send(body);
const put = (url: string, body: object) =>
  request(app).put(`/api/v1${url}`).set('Cookie', arif).send(body);

async function bikeDay(): Promise<string> {
  const res = await post('/jadwals', {
    entryType: 'amli',
    travel: { mode: 'bike', meterStart: 1000 },
  }).expect(201);
  return res.body.jadwal.id as string;
}

async function loadVillage() {
  const me = await User.findOne({ ajeerCode: '9090412' }).lean();
  villageId = String((await Village.findOne({ assignedTo: me!._id }).lean())!._id);
}

beforeAll(async () => {
  await seedDemo({ reset: true });
  arif = await loginCookie(app, '9090412');
  await loadVillage();
});

beforeEach(async () => {
  await Jadwal.deleteMany({});
});

describe('meeting tasks', () => {
  it('/meta lists the ten tasks in order, with the count and parts questions', async () => {
    const res = await request(app).get('/api/v1/meta').set('Cookie', arif).expect(200);
    const tasks = res.body.donorTasks as {
      id: string;
      count?: unknown;
      parts?: unknown[];
    }[];
    expect(tasks.map((t) => t.id)).toEqual(DEFAULT_DONOR_TASKS.map((t) => t.id));
    expect(tasks).toHaveLength(10);
    expect(tasks.find((t) => t.id === 'toray')!.count).toBeTruthy();
    expect(tasks.find((t) => t.id === 'janwar')!.parts).toHaveLength(3);
    // The day's other work is its own list (CTO 12 Nov 2026).
    expect((res.body.otherWork as { id: string }[]).map((t) => t.id)).toEqual([
      'ushr_muntaqili',
      'jins_muntaqili',
      'ushr_farokht',
      'jins_farokht',
      'sharai_heela',
      'janwar',
    ]);
  });

  it('a settings document without a task list uses the default list', async () => {
    await Setting.updateOne({ _id: 'app' }, { $unset: { donorTasks: '' } });
    clearSettingsCache();
    const res = await request(app).get('/api/v1/meta').set('Cookie', arif).expect(200);
    expect(res.body.donorTasks).toHaveLength(10);
    await seedDemo({ reset: true }); // back to the seeded document (new ids)
    arif = await loginCookie(app, '9090412');
    await loadVillage();
  });

  it('saves tasks per new donor and for the old donors met; checks each', async () => {
    const id = await bikeDay();
    const v = await post(`/jadwals/${id}/visits`, { villageId }).expect(201);
    const visitId = v.body.jadwal.visits[0].id as string;
    const url = `/jadwals/${id}/visits/${visitId}/donors`;

    const ok = await put(url, {
      oldMet: 3,
      oldTasks: [{ id: 'kisan_ijtima' }, { id: 'deeni_dawat' }],
      newDonors: [
        {
          name: 'نیا ڈونر',
          tasks: [
            { id: 'janwar', parts: ['farokht', 'niyyat', 'niyyat'] },
            { id: 'toray', count: 12 },
          ],
        },
      ],
    }).expect(200);
    // Settings order, parts once each and in settings order.
    expect(ok.body.visit.donors.oldTasks).toEqual([{ id: 'deeni_dawat' }, { id: 'kisan_ijtima' }]);
    expect(ok.body.visit.donors.newDonors[0].tasks).toEqual([
      { id: 'toray', count: 12 },
      { id: 'janwar', parts: ['niyyat', 'farokht'] },
    ]);

    const reason = async (body: object) =>
      (await put(url, body).expect(400)).body.error.details?.reason as string | undefined;
    expect(await reason({ oldMet: 0, newDonors: [], oldTasks: [{ id: 'nope' }] })).toBe(
      'UNKNOWN_TASK',
    );
    expect(await reason({ oldMet: 0, newDonors: [], oldTasks: [{ id: 'toray' }] })).toBe(
      'TASK_COUNT_REQUIRED',
    );
    expect(await reason({ oldMet: 0, newDonors: [], oldTasks: [{ id: 'gsb', count: 2 }] })).toBe(
      'TASK_COUNT_NOT_ALLOWED',
    );
    expect(await reason({ oldMet: 0, newDonors: [], oldTasks: [{ id: 'janwar' }] })).toBe(
      'TASK_PARTS_REQUIRED',
    );
    expect(
      await reason({ oldMet: 0, newDonors: [], oldTasks: [{ id: 'janwar', parts: ['heela'] }] }),
    ).toBe('TASK_PART_UNKNOWN');
    // The same task twice, a zero count: request validation.
    await put(url, {
      oldMet: 0,
      newDonors: [],
      oldTasks: [{ id: 'gsb' }, { id: 'gsb' }],
    }).expect(400);
    await put(url, { oldMet: 0, newDonors: [], oldTasks: [{ id: 'toray', count: 0 }] }).expect(400);
  });

  it('a day without any Gaon can be submitted with its other work (day tasks only)', async () => {
    const id = await bikeDay();
    const none = await post(`/jadwals/${id}/submit`, { meterEnd: 1010 }).expect(400);
    expect(none.body.error.details.reason).toBe('NO_VISITS');
    const notDay = await post(`/jadwals/${id}/submit`, {
      meterEnd: 1010,
      otherTasks: [{ id: 'deeni_dawat' }],
    }).expect(400);
    expect(notDay.body.error.details.reason).toBe('UNKNOWN_TASK'); // a meeting task, not other work
    await post(`/jadwals/${id}/submit`, { meterEnd: 1010, otherTasks: [] }).expect(400);

    const done = await post(`/jadwals/${id}/submit`, {
      meterEnd: 1010,
      otherTasks: [{ id: 'janwar', parts: ['farokht'] }, { id: 'ushr_farokht' }],
    }).expect(200);
    expect(done.body.jadwal).toMatchObject({
      status: 'submitted',
      visits: [],
      otherTasks: [{ id: 'ushr_farokht' }, { id: 'janwar', parts: ['farokht'] }],
      totals: { villages: 0, km: 10 },
    });
  });

  it('a day with Gaon may also list other work; without it nothing changes', async () => {
    const id = await bikeDay();
    await post(`/jadwals/${id}/visits`, { villageId }).expect(201);
    const done = await post(`/jadwals/${id}/submit`, { meterEnd: 1005 }).expect(200);
    expect(done.body.jadwal.otherTasks).toEqual([]);

    await Jadwal.deleteMany({});
    const both = await bikeDay();
    await post(`/jadwals/${both}/visits`, { villageId }).expect(201);
    const mixed = await post(`/jadwals/${both}/submit`, {
      meterEnd: 1005,
      otherTasks: [{ id: 'jins_muntaqili' }, { id: 'ushr_muntaqili' }],
    }).expect(200);
    expect(mixed.body.jadwal.otherTasks).toEqual([
      { id: 'ushr_muntaqili' },
      { id: 'jins_muntaqili' },
    ]);
    expect(mixed.body.jadwal.totals.villages).toBe(1);
  });
});

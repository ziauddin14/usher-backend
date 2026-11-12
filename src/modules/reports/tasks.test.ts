import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { karachiDate } from '../../lib/time.js';
import { Jadwal } from '../../models/jadwal.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';

// CTO 13 Nov 2026: reports count the meeting tasks (toray / gattu bags added up) and the day's
// other work. Invented data.
const app = createApp();
const today = karachiDate();
let arif: string; // 9090412 (Ghotki)
let district: string; // 9040001 Ghotki

const as = (cookie: string) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', cookie),
  post: (url: string, body: object = {}) =>
    request(app).post(`/api/v1${url}`).set('Cookie', cookie).send(body),
  put: (url: string, body: object) =>
    request(app).put(`/api/v1${url}`).set('Cookie', cookie).send(body),
});

beforeAll(async () => {
  await seedDemo({ reset: true });
  await Jadwal.deleteMany({});
  arif = await loginCookie(app, '9090412');
  district = await loginCookie(app, '9040001');
  const me = await User.findOne({ ajeerCode: '9090412' }).lean();
  const v = await Village.findOne({ assignedTo: me!._id }).lean();
  const day = await as(arif)
    .post('/jadwals', { entryType: 'amli', travel: { mode: 'bike', meterStart: 10 } })
    .expect(201);
  const id = day.body.jadwal.id as string;
  const visit = await as(arif).post(`/jadwals/${id}/visits`, { villageId: String(v!._id) });
  const visitId = visit.body.jadwal.visits[0].id as string;
  await as(arif)
    .put(`/jadwals/${id}/visits/${visitId}/donors`, {
      oldMet: 3,
      oldTasks: [{ id: 'kisan_ijtima' }],
      newDonors: [
        { name: 'الف', tasks: [{ id: 'toray', count: 12 }, { id: 'kisan_ijtima' }] },
        { name: 'ب', tasks: [{ id: 'toray', count: 8 }] },
      ],
    })
    .expect(200);
  await as(arif)
    .post(`/jadwals/${id}/submit`, {
      meterEnd: 20,
      otherTasks: [{ id: 'sharai_heela' }, { id: 'janwar', parts: ['niyyat'] }],
    })
    .expect(200);
});

describe('task counts in reports', () => {
  it('own counts: times per task, bags added up, other work by days', async () => {
    const res = await as(arif).get('/me/tasks?period=day').expect(200);
    const m = (id: string) => (res.body.meeting as { id: string }[]).find((x) => x.id === id);
    expect(m('toray')).toMatchObject({ times: 2, units: 20, unitsLabelUr: 'کتنی بوریاں دیں' });
    expect(m('kisan_ijtima')).toMatchObject({ times: 2, units: null });
    expect(m('gsb')).toMatchObject({ times: 0 });
    const o = (id: string) => (res.body.other as { id: string }[]).find((x) => x.id === id);
    expect(o('sharai_heela')).toMatchObject({ days: 1 });
    expect(o('ushr_farokht')).toMatchObject({ days: 0 });
    expect(res.body).toMatchObject({ days: 1, from: today, to: today });
  });

  it('the District sees the same counts for its unit; the Excel has a "Kaam" sheet', async () => {
    const res = await as(district).get('/dash/units/GHOTKI/tasks?period=day').expect(200);
    expect(
      (res.body.meeting as { id: string; units: number }[]).find((x) => x.id === 'toray')!.units,
    ).toBe(20);
    const file = await as(district)
      .get('/dash/export.xlsx?view=zimmedaran&code=GHOTKI&period=day')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.body as ArrayBuffer);
    const ws = wb.getWorksheet('Kaam')!;
    const texts: string[] = [];
    ws.eachRow((r) => texts.push((r.values as unknown[]).slice(1).map(String).join(',')));
    expect(texts.some((t) => t.includes('Toray / gattu ki taqseem,2,20'))).toBe(true);
    expect(texts.some((t) => t.includes('Sharai heela,1'))).toBe(true);
  });

  it('a zimmedar own Excel has a "کام" sheet', async () => {
    const file = await as(arif)
      .get('/me/export.xlsx?period=day')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.body as ArrayBuffer);
    expect(wb.getWorksheet('کام')).toBeDefined();
  });
});

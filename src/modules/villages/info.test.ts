import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { AuditLog } from '../../models/audit-log.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';

// CTO 17 Nov 2026: a Gaon's location, crops and local zimmedar. The Ushar Zimmedar of the Gaon
// fills an empty field once; only the Admin changes it. The Gaon list shows it and exports it.
describe('Gaon information', () => {
  const app = createApp();
  let zimmedar = '';
  let admin = '';
  let district = '';
  let villageId = '';
  let otherId = '';

  beforeAll(async () => {
    await seedDemo({ reset: true });
    zimmedar = await loginCookie(app, '9090412');
    admin = await loginCookie(app, '9100001');
    district = await loginCookie(app, '9040001');
    const mine = await request(app).get('/api/v1/villages').set('Cookie', zimmedar).expect(200);
    villageId = (mine.body.villages as { id: string; mine: boolean }[]).find((v) => v.mine)!.id;
    // Start clean: the seed may already give a local zimmedar.
    await Village.updateOne(
      { _id: villageId },
      { $unset: { localZimmedar: 1, crops: 1, cropsOther: 1, location: 1 } },
    );
    const other = await Village.findOne({
      districtCode: 'GHOTKI',
      _id: { $ne: villageId },
      assignedTo: {
        $exists: true,
        $ne: (await User.findOne({ ajeerCode: '9090412' }).lean())!._id,
      },
    }).lean();
    otherId = String(other!._id);
  });

  const patch = (cookie: string, id: string, body: object) =>
    request(app).patch(`/api/v1/villages/${id}/info`).set('Cookie', cookie).send(body);

  it('the crop list reaches the screens', async () => {
    const res = await request(app).get('/api/v1/meta').set('Cookie', zimmedar).expect(200);
    const ids = (res.body.crops as { id: string }[]).map((c) => c.id);
    expect(ids[0]).toBe('gandum');
    expect(ids).toContain('other');
    expect(ids).toHaveLength(14);
  });

  it('the zimmedar fills each empty field once', async () => {
    const res = await patch(zimmedar, villageId, {
      localZimmedar: { name: 'Haji Namoona', mobile: '0300 1234567' },
      crops: ['gandum', 'kapas', 'other'],
      cropsOther: 'Sarson',
      location: { lat: 28.0123, lng: 69.3456, accuracy: 18.6 },
    }).expect(200);
    expect(res.body.info).toEqual({
      localZimmedar: { name: 'Haji Namoona', mobile: '03001234567' },
      crops: ['gandum', 'kapas', 'other'],
      cropsOther: 'Sarson',
      location: { lat: 28.0123, lng: 69.3456, accuracy: 19, source: 'gps' },
    });

    // Once filled, only the Admin changes it.
    const again = await patch(zimmedar, villageId, {
      crops: ['ganna'],
      location: { lat: 1, lng: 1 },
    }).expect(409);
    expect(again.body.error.code).toBe('VILLAGE_INFO_SET');
    expect(again.body.error.details.fields).toEqual(['crops', 'location']);
  });

  it('never another zimmedar’s Gaon, never a viewer', async () => {
    await patch(zimmedar, otherId, { crops: ['gandum'] }).expect(404);
    await patch(district, villageId, { crops: ['gandum'] }).expect(403);
  });

  it('checks crops and mobiles', async () => {
    const bad = await patch(admin, villageId, { crops: ['chai'] }).expect(400);
    expect(bad.body.error.details.crops).toEqual(['chai']);
    await patch(admin, villageId, { localZimmedar: { mobile: '12345' } }).expect(400);
  });

  it('the Admin changes and clears; audited with the mobile masked', async () => {
    const res = await patch(admin, villageId, {
      localZimmedar: { mobile: '03111234567' },
      crops: ['ganna'],
      location: { lat: 27.5, lng: 68.75 },
    }).expect(200);
    expect(res.body.info.localZimmedar).toEqual({ name: 'Haji Namoona', mobile: '03111234567' });
    expect(res.body.info.crops).toEqual(['ganna']);
    expect(res.body.info.cropsOther).toBeNull();
    expect(res.body.info.location).toMatchObject({ lat: 27.5, lng: 68.75, source: 'admin' });

    const log = await AuditLog.findOne({ action: 'VILLAGE_INFO', actorAjeerCode: '9100001' })
      .sort({ _id: -1 })
      .lean();
    expect(JSON.stringify(log?.details)).toContain('0311•••4567');
    expect(JSON.stringify(log?.details)).not.toContain('03111234567');

    const cleared = await patch(admin, villageId, { location: null }).expect(200);
    expect(cleared.body.info.location).toBeNull();
    // Empty again: the zimmedar may fill it.
    await patch(zimmedar, villageId, { location: { lat: 28, lng: 69 } }).expect(200);
  });

  it('the zimmedar sees it on the Gaon screen', async () => {
    const res = await request(app)
      .get(`/api/v1/villages/${villageId}/donors`)
      .set('Cookie', zimmedar)
      .expect(200);
    expect(res.body.village).toMatchObject({
      localZimmedar: { name: 'Haji Namoona', mobile: '03111234567' },
      crops: ['ganna'],
      location: { lat: 28, lng: 69, source: 'gps' },
    });
  });

  it('a Gaon added with the phone’s location keeps it', async () => {
    const res = await request(app)
      .post('/api/v1/villages')
      .set('Cookie', zimmedar)
      .send({ name: 'Naya Namoona Gaon', location: { lat: 28.1, lng: 69.2, accuracy: 30 } })
      .expect(201);
    const v = await Village.findById(res.body.village.id).lean();
    expect(v?.location).toMatchObject({ lat: 28.1, lng: 69.2, accuracy: 30, source: 'gps' });
  });

  it('the Gaon list shows it, filters missing information and exports Excel', async () => {
    const list = await request(app)
      .get('/api/v1/dash/villages?district=GHOTKI&q=')
      .set('Cookie', district)
      .expect(200);
    const row = (
      list.body.villages as {
        id: string;
        crops: { labelUr: string }[];
        localZimmedar: { name: string } | null;
        donors: number;
      }[]
    ).find((v) => v.id === villageId)!;
    expect(row.crops.map((c) => c.labelUr)).toEqual(['گنا']);
    expect(row.localZimmedar?.name).toBe('Haji Namoona');
    expect(typeof row.donors).toBe('number');
    expect(list.body.counts.noLocation).toBe(list.body.counts.all - 2);

    const noLoc = await request(app)
      .get('/api/v1/dash/villages?district=GHOTKI&info=noLocation')
      .set('Cookie', district)
      .expect(200);
    expect((noLoc.body.villages as { id: string }[]).some((v) => v.id === villageId)).toBe(false);

    const xl = await request(app)
      .get('/api/v1/dash/villages/export.xlsx?district=GHOTKI')
      .set('Cookie', district)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xl.body as ArrayBuffer);
    const ws = wb.getWorksheet('Gaon')!;
    expect(ws.getRow(2).getCell(1).value).toBe('Suba');
    let found = false;
    ws.eachRow((r) => {
      if (r.getCell(8).value !== 'Haji Namoona') return;
      found = true;
      expect(r.getCell(3).value).toBe('Ghotki');
      // The mobile shows masked; the full number is the link behind it.
      expect(r.getCell(9).value).toEqual({ text: '0311•••4567', hyperlink: 'tel:+923111234567' });
      expect(r.getCell(10).value).toBe('گنا');
      expect(r.getCell(12).value).toMatchObject({
        hyperlink: 'https://www.google.com/maps?q=28,69',
      });
    });
    expect(found).toBe(true);
  });
});

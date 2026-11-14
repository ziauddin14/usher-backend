// Village management (CTO 7 Nov 2026; by the Admin only since CTO 14 Nov 2026): add, assign
// existing / new, reassign, correct, duplicates and merge — duplicate prevention and audit. District
// and Division only view. Invented seed data only.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { AuditLog } from '../../models/audit-log.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';

const app = createApp();
let admin: string; // 9100001, the Admin
let district: string; // 9040001, Ghotki (view only)
let zimmedar: string; // 9090412, Ghotki
let zimmedarId: string;
let otherGhotki: { id: string; ajeerCode: string };
let foreign: { id: string; ajeerCode: string; unitCode: string; unitPath: string };

const post = (path: string, cookie: string, body: object) =>
  request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body);

describe('District village management', () => {
  beforeAll(async () => {
    await seedDemo({ reset: true });
    admin = await loginCookie(app, '9100001');
    district = await loginCookie(app, '9040001');
    zimmedar = await loginCookie(app, '9090412');
    zimmedarId = String((await User.findOne({ ajeerCode: '9090412' }).lean())!._id);
    const o = await User.findOne({
      role: 'zimmedar',
      unitCode: 'GHOTKI',
      ajeerCode: { $ne: '9090412' },
    }).lean();
    otherGhotki = { id: String(o!._id), ajeerCode: o!.ajeerCode };
    const f = await User.findOne({ role: 'zimmedar', unitCode: { $ne: 'GHOTKI' } }).lean();
    foreign = {
      id: String(f!._id),
      ajeerCode: f!.ajeerCode,
      unitCode: f!.unitCode,
      unitPath: f!.unitPath,
    };
  });

  it('a zimmedar cannot use the management endpoints (403)', async () => {
    await post('/villages/manage', zimmedar, { name: 'گوٹھ آزمائش' }).expect(403);
    await request(app).get('/api/v1/villages/duplicates').set('Cookie', zimmedar).expect(403);
  });

  it('the Admin adds a new village (approved, source district) and assigns it at once', async () => {
    const res = await post('/villages/manage', admin, {
      name: '  گوٹھ   نئی بستی ',
      assignTo: zimmedarId,
      districtCode: 'GHOTKI',
    }).expect(201);
    expect(res.body.village).toMatchObject({
      name: 'گوٹھ نئی بستی',
      status: 'approved',
      assignedTo: zimmedarId,
    });
    const saved = await Village.findById(res.body.village.id).lean();
    expect(saved?.source).toMatchObject({ kind: 'district' });
    const log = await AuditLog.findOne({
      action: 'VILLAGE_CREATE',
      targetId: res.body.village.id,
    }).lean();
    expect(log?.details).toMatchObject({ name: 'گوٹھ نئی بستی' });

    // The zimmedar sees it in their own list (no search).
    const mine = await request(app).get('/api/v1/villages').set('Cookie', zimmedar).expect(200);
    expect((mine.body.villages as { id: string }[]).some((v) => v.id === res.body.village.id)).toBe(
      true,
    );
  });

  it('the same name again is refused with the existing village (assign it instead)', async () => {
    const res = await post('/villages/manage', admin, {
      name: 'نئی بستی',
      districtCode: 'GHOTKI',
    }).expect(409);
    expect(res.body.error.code).toBe('VILLAGE_EXISTS');
    expect(res.body.error.details.village).toMatchObject({ name: 'گوٹھ نئی بستی' });
    // Assigning the existing record to another zimmedar = reassignment, no new village.
    const id = res.body.error.details.village.id as string;
    await post(`/villages/${id}/assign`, admin, { userId: otherGhotki.id }).expect(200);
    expect(await Village.countDocuments({ nameKey: 'نئی بستی' })).toBe(1);
    const log = await AuditLog.findOne({ action: 'VILLAGE_REASSIGN', targetId: id }).lean();
    expect(log?.details).toMatchObject({ to: { ajeerCode: otherGhotki.ajeerCode } });
    // …and it left the first zimmedar's list.
    const mine = await request(app).get('/api/v1/villages').set('Cookie', zimmedar).expect(200);
    expect((mine.body.villages as { id: string }[]).some((v) => v.id === id)).toBe(false);
  });

  it('an existing pool village is assigned without creating a duplicate', async () => {
    const pool = await Village.create({
      name: 'گوٹھ تالاب',
      nameKey: 'تالاب',
      districtCode: 'GHOTKI',
      unitPath: 'PK/INT_SINDH/SUKKUR/GHOTKI',
      status: 'approved',
    });
    const before = await Village.countDocuments();
    await post(`/villages/${pool._id.toHexString()}/assign`, admin, {
      userId: zimmedarId,
    }).expect(200);
    expect(await Village.countDocuments()).toBe(before);
    expect(String((await Village.findById(pool._id).lean())?.assignedTo)).toBe(zimmedarId);
  });

  it('cannot assign to a zimmedar of another district, nor create there (scope)', async () => {
    const created = await post('/villages/manage', admin, {
      name: 'گوٹھ سرحد',
      districtCode: 'GHOTKI',
    }).expect(201);
    const id = created.body.village.id as string;
    const bad = await post(`/villages/${id}/assign`, admin, { userId: foreign.id }).expect(409);
    expect(bad.body.error.code).toBe('CONFLICT');
    await post('/villages/manage', admin, {
      name: 'گوٹھ سرحد',
      assignTo: foreign.id,
      districtCode: 'GHOTKI',
    }).expect(409);
    // A unit that is not a District is refused.
    await post('/villages/manage', admin, { name: 'گوٹھ باہر', districtCode: 'SUKKUR' }).expect(
      400,
    );
    expect(await Village.countDocuments({ nameKey: 'باہر' })).toBe(0);
  });

  it('District and Division only view: they cannot add, rename, assign or merge (CTO 14 Nov 2026)', async () => {
    const v = await Village.findOne({ districtCode: 'GHOTKI', status: 'approved' }).lean();
    const id = v!._id.toHexString();
    const division = await loginCookie(app, '9030001');
    for (const who of [district, division]) {
      await post('/villages/manage', who, { name: 'گوٹھ منع', districtCode: 'GHOTKI' }).expect(403);
      await request(app)
        .patch(`/api/v1/villages/${id}`)
        .set('Cookie', who)
        .send({ name: 'گوٹھ چوری' })
        .expect(403);
      await post(`/villages/${id}/assign`, who, { userId: zimmedarId }).expect(403);
      await post(`/villages/${id}/merge`, who, { intoId: id }).expect(403);
      await request(app).get('/api/v1/villages/duplicates').set('Cookie', who).expect(403);
    }
    expect((await Village.findById(id).lean())?.name).toBe(v!.name);
  });

  it('corrects a spelling: old name kept, audited, a taken name refused', async () => {
    const v = await post('/villages/manage', admin, {
      name: 'گوٹھ غلط ہجے',
      districtCode: 'GHOTKI',
    }).expect(201);
    const id = v.body.village.id as string;
    const res = await request(app)
      .patch(`/api/v1/villages/${id}`)
      .set('Cookie', admin)
      .send({ name: 'گوٹھ درست ہجے', tehsil: 'Ubauro' })
      .expect(200);
    expect(res.body.village.name).toBe('گوٹھ درست ہجے');
    const saved = await Village.findById(id).lean();
    expect(saved).toMatchObject({ nameKey: 'درست ہجے', tehsil: 'Ubauro' });
    expect(saved?.formerNames?.map((f) => f.nameKey)).toEqual(['غلط ہجے']);
    const log = await AuditLog.findOne({ action: 'VILLAGE_RENAME', targetId: id }).lean();
    expect(log?.details).toMatchObject({
      from: { name: 'گوٹھ غلط ہجے' },
      to: { name: 'گوٹھ درست ہجے' },
    });

    // The old spelling now leads to this village (district add and zimmedar add).
    const again = await post('/villages/manage', admin, {
      name: 'غلط ہجے',
      districtCode: 'GHOTKI',
    }).expect(409);
    expect(again.body.error.details.village.id).toBe(id);
    const z = await post('/villages', zimmedar, { name: 'گوٹھ غلط ہجے' }).expect(409);
    expect(z.body.error.details.village.id).toBe(id);

    // Renaming to a name another village has → 409.
    const taken = await request(app)
      .patch(`/api/v1/villages/${id}`)
      .set('Cookie', admin)
      .send({ name: 'گوٹھ نئی بستی' })
      .expect(409);
    expect(taken.body.error.code).toBe('VILLAGE_EXISTS');
  });

  it('finds look-alike villages and merges one into the other (spelling kept on the survivor)', async () => {
    const a = await post('/villages/manage', admin, {
      name: 'گوٹھ پیر بخش',
      districtCode: 'GHOTKI',
    }).expect(201);
    const b = await post('/villages/manage', admin, {
      name: 'گوٹھ پیربخش',
      districtCode: 'GHOTKI',
    }).expect(201);
    const dup = await request(app)
      .get('/api/v1/villages/duplicates?unit=GHOTKI')
      .set('Cookie', admin)
      .expect(200);
    const group = (dup.body.groups as { id: string }[][]).find((g) =>
      g.some((v) => v.id === a.body.village.id),
    );
    expect(group?.map((v) => v.id).sort()).toEqual([a.body.village.id, b.body.village.id].sort());

    await post(`/villages/${b.body.village.id}/merge`, admin, {
      intoId: a.body.village.id,
    }).expect(200);
    const merged = await Village.findById(b.body.village.id).lean();
    expect(merged).toMatchObject({ status: 'merged' });
    const survivor = await Village.findById(a.body.village.id).lean();
    expect(survivor?.formerNames?.map((f) => f.nameKey)).toContain('پیربخش');
    expect(await AuditLog.countDocuments({ action: 'VILLAGE_MERGE' })).toBeGreaterThan(0);
    // The merged spelling cannot be added again.
    await post('/villages/manage', admin, { name: 'پیربخش', districtCode: 'GHOTKI' }).expect(409);
  });
});

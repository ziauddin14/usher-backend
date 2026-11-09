// Phase 2 (CTO 9 Nov 2026): Tehsil as its own unit level and role, with invented data only.
// Hierarchy Pakistan → Suba → Division → District → Tehsil → Ushar Zimmedar; Gaon stay owned at
// District level; a Tehsil sees only its own Ushar Zimmedaran and changes nothing; an Ushar
// Zimmedar's official duty is still decided by the District.
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import type { AuthUser } from '../../lib/auth.js';
import { districtCodeOf, districtPathOf } from '../../lib/scope.js';
import { createApp } from '../../index.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';
import { assertDutyApprover, DUTY_APPROVER } from '../jadwals/duty.js';
import { importVillages, type VillageRow } from '../import/villages.js';
import { resetPassword, setUserStatus } from '../users/service.js';

const app = createApp();
const GHOTKI = 'PK/INT_SINDH/SUKKUR/GHOTKI';
const T1 = `${GHOTKI}/GHOTKI_T1`;
const T2 = `${GHOTKI}/GHOTKI_T2`;

let cookies: Record<string, string> = {};
let z1: { id: string; code: string };
let z2: { id: string; code: string };
let z3: { id: string; code: string };
let tehsil1Id: string;
let larkanaZimmedarId: string;

const get = (who: string, path: string) =>
  request(app).get(`/api/v1${path}`).set('Cookie', cookies[who]!);
const post = (who: string, path: string, body: object = {}) =>
  request(app).post(`/api/v1${path}`).set('Cookie', cookies[who]!).send(body);

async function addUser(ajeerCode: string, role: 'tehsil', unitCode: string, unitPath: string) {
  const u = await User.create({
    ajeerCode,
    name: `Invented ${ajeerCode}`,
    role,
    unitCode,
    unitPath,
    passwordHash: await bcrypt.hash('demo1234', 4),
    mustChangePassword: false,
    isDemo: false,
  });
  return String(u._id);
}

beforeAll(async () => {
  await seedDemo({ reset: true });
  await Unit.create([
    {
      code: 'GHOTKI_T1',
      name: 'Invented Tehsil One',
      level: 'tehsil',
      parentCode: 'GHOTKI',
      path: T1,
    },
    {
      code: 'GHOTKI_T2',
      name: 'Invented Tehsil Two',
      level: 'tehsil',
      parentCode: 'GHOTKI',
      path: T2,
    },
  ]);
  // Three Ghotki Ushar Zimmedaran move under the Tehsils (9090412 stays directly under the District).
  const ghotki = await User.find({
    role: 'zimmedar',
    unitCode: 'GHOTKI',
    ajeerCode: { $ne: '9090412' },
  })
    .sort({ ajeerCode: 1 })
    .limit(3)
    .lean();
  [z1, z2, z3] = ghotki.map((u) => ({ id: String(u._id), code: u.ajeerCode })) as [
    typeof z1,
    typeof z1,
    typeof z1,
  ];
  await User.updateMany(
    { _id: { $in: [z1.id, z2.id] } },
    { $set: { unitCode: 'GHOTKI_T1', unitPath: T1 } },
  );
  await User.updateOne({ _id: z3.id }, { $set: { unitCode: 'GHOTKI_T2', unitPath: T2 } });
  tehsil1Id = await addUser('9060001', 'tehsil', 'GHOTKI_T1', T1);
  await addUser('9060002', 'tehsil', 'GHOTKI_T2', T2);
  larkanaZimmedarId = String(
    (await User.findOne({ role: 'zimmedar', unitCode: 'LARKANA_DIST' }).lean())!._id,
  );
  cookies = {
    t1: await loginCookie(app, '9060001'),
    t2: await loginCookie(app, '9060002'),
    district: await loginCookie(app, '9040001'),
    division: await loginCookie(app, '9030001'),
    z1: await loginCookie(app, z1.code),
  };
});

describe('central District helper', () => {
  it('resolves the District of a District, Tehsil or Ushar path; null above District', () => {
    expect(districtPathOf(GHOTKI)).toBe(GHOTKI);
    expect(districtPathOf(T1)).toBe(GHOTKI);
    expect(districtPathOf('PK/INT_SINDH/SUKKUR')).toBeNull();
    expect(districtCodeOf(T1)).toBe('GHOTKI');
  });
});

describe('hierarchy and data isolation', () => {
  it('a Tehsil unit belongs to its District', async () => {
    const t1 = await Unit.findOne({ code: 'GHOTKI_T1' }).lean();
    expect(t1).toMatchObject({ level: 'tehsil', parentCode: 'GHOTKI' });
    expect(t1!.path.startsWith(`${GHOTKI}/`)).toBe(true);
  });

  it('a Tehsil lists only its own Ushar Zimmedaran', async () => {
    const res = await get('t1', '/users').expect(200);
    const ids = (res.body.users as { id: string; role: string }[]).map((u) => u.id).sort();
    expect(ids).toEqual([z1.id, z2.id].sort());
    expect(JSON.stringify(res.body)).not.toContain(z3.id);
  });

  it('a Tehsil opens its own dashboard and Zimmedar details — never another Tehsil, its District or another District', async () => {
    await get('t1', '/dash/units/GHOTKI_T1/overview').expect(200);
    const table = await get('t1', '/dash/units/GHOTKI_T1/zimmedaran').expect(200);
    const rows = table.body.rows as { id?: string; userId?: string; ajeerCode: string }[];
    expect(rows.map((r) => r.ajeerCode).sort()).toEqual([z1.code, z2.code].sort());
    await get('t1', `/dash/zimmedaran/${z1.id}/days`).expect(200);

    await get('t1', '/dash/units/GHOTKI_T2/overview').expect(404);
    await get('t1', '/dash/units/GHOTKI/overview').expect(404);
    await get('t1', '/dash/units/LARKANA_DIST/overview').expect(404);
    await get('t1', `/dash/zimmedaran/${z3.id}/days`).expect(404);
    await get('t1', `/dash/zimmedaran/${larkanaZimmedarId}/days`).expect(404);
  });

  it('the District still sees every Tehsil and all their Ushar Zimmedaran; the Division too', async () => {
    await get('district', '/dash/units/GHOTKI_T1/overview').expect(200);
    await get('district', '/dash/units/GHOTKI_T2/overview').expect(200);
    const table = await get('district', '/dash/units/GHOTKI/zimmedaran').expect(200);
    const codes = (table.body.rows as { ajeerCode: string }[]).map((r) => r.ajeerCode);
    expect(codes).toEqual(expect.arrayContaining([z1.code, z2.code, z3.code, '9090412']));
    const users = await get('district', '/users').expect(200);
    const listed = (users.body.users as { ajeerCode: string; role: string }[]).map(
      (u) => u.ajeerCode,
    );
    expect(listed).toEqual(expect.arrayContaining(['9060001', '9060002', z1.code, z3.code]));
    await get('division', '/dash/units/GHOTKI_T2/overview').expect(200);
  });

  it('an Ushar Zimmedar still gets no dashboard', async () => {
    await get('z1', '/dash/units/GHOTKI_T1/overview').expect(403);
  });
});

describe('Gaon stay owned at District level', () => {
  let villageId: string;

  beforeAll(async () => {
    const v = await Village.findOne({ unitPath: GHOTKI, assignedTo: { $exists: true } }).lean();
    villageId = String(v!._id);
    await Village.updateOne({ _id: v!._id }, { $set: { assignedTo: new Types.ObjectId(z1.id) } });
  });

  it('a Tehsil Ushar Zimmedar lists, uses and adds villages of their District', async () => {
    const mine = await get('z1', '/villages').expect(200);
    expect((mine.body.villages as { id: string }[]).map((v) => v.id)).toContain(villageId);
    const day = await post('z1', '/jadwals', {
      entryType: 'amli',
      travel: { mode: 'bus', fare: 0 },
    }).expect(201);
    await post('z1', `/jadwals/${day.body.jadwal.id as string}/visits`, { villageId }).expect(201);
    const added = await post('z1', '/villages', { name: 'گوٹھ تحصیل آزمائش' }).expect(201);
    expect(await Village.findById(added.body.village.id).lean()).toMatchObject({
      unitPath: GHOTKI,
      districtCode: 'GHOTKI',
    });
  });

  it('the District assigns a village to a Tehsil Ushar Zimmedar of its own District only', async () => {
    const created = await post('district', '/villages/manage', {
      name: 'گوٹھ تحصیل منتقلی',
      assignTo: z3.id,
    }).expect(201);
    expect(created.body.village.assignedTo).toBe(z3.id);
    await post('district', `/villages/${created.body.village.id as string}/assign`, {
      userId: z1.id,
    }).expect(200);
    await post('district', `/villages/${created.body.village.id as string}/assign`, {
      userId: larkanaZimmedarId,
    }).expect(409);
  });

  it('a Tehsil sees only the villages of its own Ushar Zimmedaran — never the District pool', async () => {
    await Village.create({
      name: 'گوٹھ تحصیل پول',
      nameKey: 'تحصیل پول',
      districtCode: 'GHOTKI',
      unitPath: GHOTKI,
      status: 'approved',
    });
    const list = await get('t1', '/villages').expect(200);
    const ids = (list.body.villages as { id: string }[]).map((v) => v.id);
    expect(ids).toContain(villageId);
    const pool = await Village.findOne({ nameKey: 'تحصیل پول' }).lean();
    expect(ids).not.toContain(String(pool!._id));
    const dash = await get('t1', '/dash/units/GHOTKI_T1/villages').expect(200);
    expect(dash.body.pool).toEqual([]);
    expect(dash.body.orphaned).toEqual([]);
    expect((dash.body.zimmedaran as { id: string }[]).map((z) => z.id).sort()).toEqual(
      [z1.id, z2.id].sort(),
    );
  });

  it('the village import assigns a Tehsil Ushar Zimmedar in their District; another District is District farq', async () => {
    const rows: VillageRow[] = [
      {
        row: 2,
        values: { village: 'گوٹھ تحصیل درآمد', district: 'Ghotki', zimmedarCode: z2.code },
      },
      {
        row: 3,
        values: { village: 'گوٹھ غلط ضلع تحصیل', district: 'Larkana', zimmedarCode: z2.code },
      },
      {
        row: 4,
        values: { village: 'گوٹھ تحصیل ذمہ دار', district: 'Ghotki', zimmedarCode: '9060001' },
      },
    ];
    const r = await importVillages(rows, { dryRun: false });
    expect(r.assigned).toBe(1);
    expect(r.districtMismatch.map((u) => u.row)).toEqual([3]);
    // A Tehsil Zimmedar is not an Ushar Zimmedar: the village goes to the District pool.
    expect(r.districtPool.map((u) => u.row)).toEqual([4]);
    const v = await Village.findOne({ nameKey: 'تحصیل درآمد' }).lean();
    expect(v).toMatchObject({ unitPath: GHOTKI });
    expect(String(v!.assignedTo)).toBe(z2.id);
  });
});

describe('a Tehsil changes nothing; official duty stays with the District', () => {
  it('no password reset, no activate / deactivate, no reset requests, no Gaon management, no reopen or duty decision', async () => {
    await post('t1', `/users/${z1.id}/reset-password`).expect(403);
    await post('t1', `/users/${z1.id}/status`, { isActive: false }).expect(403);
    await get('t1', '/users/reset-requests').expect(403);
    await post('t1', '/villages/manage', { name: 'گوٹھ ممنوع' }).expect(403);
    await get('t1', '/villages/pending').expect(403);
    const v = await Village.findOne({ unitPath: GHOTKI }).lean();
    await post('t1', `/villages/${String(v!._id)}/assign`, { userId: z1.id }).expect(403);
    const anyId = new Types.ObjectId().toHexString();
    await post('t1', `/jadwals/${anyId}/reopen`, { reason: 'galat entry' }).expect(403);
    await post('t1', `/jadwals/${anyId}/duty-approval`, { decision: 'approve' }).expect(403);
    expect((await User.findById(z1.id).lean())!.isActive).toBe(true);
  });

  it('the services refuse a Tehsil too (not only the routes)', async () => {
    const t1: AuthUser = {
      id: tehsil1Id,
      ajeerCode: '9060001',
      name: 'x',
      role: 'tehsil',
      unitCode: 'GHOTKI_T1',
      unitPath: T1,
      mustChangePassword: false,
    };
    await expect(resetPassword(t1, z1.id)).rejects.toMatchObject({ status: 403 });
    await expect(setUserStatus(t1, z1.id, false)).rejects.toMatchObject({ status: 403 });
  });

  it('an Ushar Zimmedar under a Tehsil: duty is decided by the District, never the Tehsil', () => {
    expect(DUTY_APPROVER.zimmedar).toBe('district');
    expect(DUTY_APPROVER.tehsil).toBe('district');
    const caller = (role: AuthUser['role']): AuthUser => ({
      id: 'caller',
      ajeerCode: '1',
      name: 'x',
      role,
      unitCode: 'X',
      unitPath: GHOTKI,
      mustChangePassword: false,
    });
    const owner = { _id: z1.id, role: 'zimmedar' as const };
    expect(() => assertDutyApprover(caller('district'), owner)).not.toThrow();
    expect(() => assertDutyApprover(caller('tehsil'), owner)).toThrow(/directly above/);
    expect(() => assertDutyApprover(caller('division'), owner)).toThrow(/directly above/);
    expect(() =>
      assertDutyApprover(caller('district'), { _id: tehsil1Id, role: 'tehsil' }),
    ).not.toThrow();
  });
});

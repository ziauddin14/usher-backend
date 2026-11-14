import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { AuditLog } from '../../models/audit-log.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';
import { importVillages, readVillageSheet } from '../import/villages.js';

// CTO 13 Nov 2026: no Tehsil level — a Tehsil/Town Zimmedar is a zimmedar of the District; a Gaon
// that cannot be assigned waits in the District pool with its problem and the way to fix it.
const app = createApp();
let district: string; // 9040001 Ghotki
let admin: string; // 9100001 — fixes the pool (CTO 14 Nov 2026)
let dir: string;
let existing: { id: string; name: string };

const as = (cookie: string) => ({
  get: (url: string) => request(app).get(`/api/v1${url}`).set('Cookie', cookie),
  post: (url: string, body: object = {}) =>
    request(app).post(`/api/v1${url}`).set('Cookie', cookie).send(body),
  patch: (url: string, body: object) =>
    request(app).patch(`/api/v1${url}`).set('Cookie', cookie).send(body),
});

interface PoolItem {
  id: string;
  name: string;
  issues: { kind: string; suggestionId: string | null; suggestionName: string | null }[];
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ushr-pool-'));
  await seedDemo({ reset: true });
  district = await loginCookie(app, '9040001');
  const bcrypt = await import('bcryptjs');
  await User.create({
    ajeerCode: '40002',
    name: 'Test Larkana District',
    role: 'district',
    unitCode: 'LARKANA_DIST',
    unitPath: 'PK/INT_SINDH/LARKANA/LARKANA_DIST',
    passwordHash: await bcrypt.default.hash('demo1234', 4),
    mustChangePassword: false,
  });
  admin = await loginCookie(app, '9100001');
  const v = await Village.findOne({ districtCode: 'GHOTKI', status: 'approved' })
    .sort({ nameKey: -1 })
    .lean();
  existing = { id: String(v!._id), name: v!.name };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('no Tehsil level', () => {
  it('the Tehsil/Town Zimmedar works in the zimmedar app; there is no Tehsil dashboard', async () => {
    const t = await loginCookie(app, '9050001');
    const me = await as(t).get('/auth/me').expect(200);
    expect(me.body.user).toMatchObject({ role: 'zimmedar', zimmedari: 'tehsil_town' });
    await as(t).get('/jadwals/today').expect(200);
    await as(t).get('/dash/units/KHAIRPUR/overview?period=day').expect(403);
  });
});

describe('District pool: problems and fixes', () => {
  it('the import marks a near-duplicate name, and an unknown code, on the pool Gaon', async () => {
    // One letter added to an existing Ghotki Gaon, with a code nobody has.
    const like = `${existing.name}ی`;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Mulk', 'Soba', 'Division', 'District', 'Tehsil', 'گاؤں کا نام', 'Employee Code']);
    ws.addRow(['Pakistan', 'Interior Sindh', 'Sukkur', 'District Ghotki', '', like, '77777']);
    const file = join(dir, 'gaon.xlsx');
    await wb.xlsx.writeFile(file);
    await importVillages(await readVillageSheet(file), { dryRun: false });

    const res = await as(district).get('/dash/units/GHOTKI/villages').expect(200);
    const item = (res.body.pool as PoolItem[]).find((p) => p.name === like)!;
    expect(item.issues.map((i) => i.kind).sort()).toEqual(['SIMILAR_NAME', 'ZIMMEDAR_NOT_FOUND']);
    expect(item.issues.find((i) => i.kind === 'SIMILAR_NAME')).toMatchObject({
      suggestionId: existing.id,
      suggestionName: existing.name,
    });
  });

  it('"theek hai" clears one problem (audited); a rename clears the name problem; assign clears all', async () => {
    const like = `${existing.name}ی`;
    const v = await Village.findOne({ name: like }).lean();
    const id = String(v!._id);
    await as(district).post(`/villages/${id}/resolve-issue`, { kind: 'SIMILAR_NAME' }).expect(403);
    await as(admin).post(`/villages/${id}/resolve-issue`, { kind: 'NOPE' }).expect(400);

    await as(admin)
      .post(`/villages/${id}/resolve-issue`, { kind: 'ZIMMEDAR_NOT_FOUND' })
      .expect(200);
    expect((await Village.findById(id).lean())!.issues!.map((i) => i.kind)).toEqual([
      'SIMILAR_NAME',
    ]);
    expect(await AuditLog.countDocuments({ action: 'VILLAGE_ISSUE_RESOLVE', targetId: id })).toBe(
      1,
    );

    await as(admin)
      .patch(`/villages/${id}`, { name: `${existing.name} نیا` })
      .expect(200);
    expect((await Village.findById(id).lean())!.issues).toBeUndefined();

    // Assigning a pool Gaon clears whatever kept it there.
    await Village.updateOne({ _id: id }, { $set: { issues: [{ kind: 'ZIMMEDAR_NOT_FOUND' }] } });
    const z = await User.findOne({ role: 'zimmedar', unitCode: 'GHOTKI' }).lean();
    await as(admin)
      .post(`/villages/${id}/assign`, { userId: String(z!._id) })
      .expect(200);
    expect((await Village.findById(id).lean())!.issues).toBeUndefined();
  });
});

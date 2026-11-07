// CTO 7 Nov 2026 — initial employee passwords, for every role, with invented data only:
// - a newly imported (or centrally provisioned Pakistan Admin) account gets the initial password
//   demo1234, stored only as a bcrypt hash, with mustChangePassword;
// - until the password is changed every protected API answers 403 PASSWORD_CHANGE_REQUIRED
//   (only /auth/me, /auth/change-password and /auth/logout stay open);
// - after the change the normal role-based access applies;
// - a repeated HR import never gives demo1234 (or any password) to an existing account.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../index.js';
import { type Role, User } from '../../models/user.js';
import { seedDemo } from '../../seed/seed.js';
import { importEmployees, readEmployeeSheet } from '../import/employees.js';
import { provisionPakistanAdmin } from '../users/provision.js';
import { INITIAL_PASSWORD } from './schemas.js';

const app = createApp();
let dir: string;
let file: string;

/** One invented account per role; unit = the unit its dashboards open. */
const ACCOUNTS: { code: string; role: Role; unit: string }[] = [
  { code: '860001', role: 'zimmedar', unit: 'GHOTKI' },
  { code: '860002', role: 'district', unit: 'GHOTKI' },
  { code: '860003', role: 'division', unit: 'SUKKUR' },
  { code: '860004', role: 'suba', unit: 'INT_SINDH' },
  { code: '860005', role: 'pakistan', unit: 'PK' },
];

const HEADER = ['Ajeer Code', 'Naam', 'Zimmedari', 'Suba', 'Division', 'District', 'Mobile'];
const ROWS = [
  ['860001/1', 'Invented Zimmedar', 'Ushar', 'Interior Sindh', 'Sukkur', 'Ghotki', ''],
  ['860002/1', 'Invented District', 'District', 'Interior Sindh', 'Sukkur', 'Ghotki', ''],
  ['860003/1', 'Invented Division', 'Division', 'Interior Sindh', 'Sukkur', '', ''],
  ['860004/1', 'Invented Suba', 'Suba', 'Interior Sindh', '', '', ''],
];

/** Protected endpoints for each role (all must answer 403 before the change). */
function protectedPaths(role: Role, unit: string): string[] {
  const common = ['/api/v1/meta', '/api/v1/villages', '/api/v1/auth/mobile', '/api/v1/jadwals'];
  if (role === 'zimmedar') {
    return [...common, '/api/v1/me/summary', '/api/v1/me/reward', '/api/v1/jadwals/today'];
  }
  return [
    ...common,
    '/api/v1/users',
    '/api/v1/users/reset-requests',
    `/api/v1/dash/units/${unit}/overview`,
    `/api/v1/dash/units/${unit}/zimmedaran`,
    '/api/v1/villages/pending',
  ];
}

/** After the change: endpoints the role may use, and one it may not (role-based access). */
function afterChange(role: Role, unit: string): { allowed: string[]; forbidden: string } {
  if (role === 'zimmedar') {
    return {
      allowed: ['/api/v1/meta', '/api/v1/me/summary', '/api/v1/jadwals/today', '/api/v1/villages'],
      forbidden: '/api/v1/users',
    };
  }
  return {
    allowed: ['/api/v1/meta', '/api/v1/users', `/api/v1/dash/units/${unit}/overview`],
    forbidden: '/api/v1/me/summary',
  };
}

const login = (ajeerCode: string, password: string) =>
  request(app).post('/api/v1/auth/login').send({ ajeerCode, password });
const cookieOf = (res: { headers: Record<string, unknown> }) =>
  (res.headers['set-cookie'] as string[])[0]!.split(';')[0]!;

describe('initial password demo1234 and the forced change, for every role', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ushr-roles-'));
    await seedDemo({ reset: true });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('HR');
    ws.addRow(HEADER);
    for (const r of ROWS) ws.addRow(r);
    file = join(dir, 'hr.xlsx');
    await wb.xlsx.writeFile(file);
    const result = await importEmployees(await readEmployeeSheet(file), { dryRun: false });
    expect(result).toMatchObject({ created: 4, updated: 0, errors: [] });
    // Pakistan Admin accounts are never imported — only centrally provisioned.
    const admin = await provisionPakistanAdmin({
      ajeerCode: '860005',
      name: 'Invented Pakistan Admin',
      nominationRef: 'NOM/T/1',
      approvalRef: 'APR/T/1',
      operator: 'test',
    });
    expect(admin.ok).toBe(true);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('every new account has the initial password only as a bcrypt hash, and must change it', async () => {
    for (const a of ACCOUNTS) {
      const u = await User.findOne({ ajeerCode: a.code }).select('+passwordHash').lean();
      expect(u, a.code).toMatchObject({ role: a.role, mustChangePassword: true, isActive: true });
      expect(u!.passwordHash).toMatch(/^\$2[aby]\$10\$/); // bcrypt, cost 10
      expect(u!.passwordHash).not.toContain(INITIAL_PASSWORD);
      expect(await bcrypt.compare(INITIAL_PASSWORD, u!.passwordHash)).toBe(true);
      expect(JSON.stringify(u)).not.toContain(INITIAL_PASSWORD); // no plaintext in any field
      expect(u!.mobile).toBeUndefined(); // the mobile stays optional
    }
    expect(INITIAL_PASSWORD).toBe('demo1234');
  });

  for (const a of ACCOUNTS) {
    it(`${a.role}: first login → change required; every protected API 403 until changed; then role access`, async () => {
      const first = await login(a.code, INITIAL_PASSWORD).expect(200);
      expect(first.body.user).toMatchObject({ role: a.role, mustChangePassword: true });
      const cookie = cookieOf(first);

      for (const path of protectedPaths(a.role, a.unit)) {
        const res = await request(app).get(path).set('Cookie', cookie);
        expect(res.status, `${a.role} ${path}`).toBe(403);
        expect(res.body.error.code, `${a.role} ${path}`).toBe('PASSWORD_CHANGE_REQUIRED');
      }
      // Writes are blocked too.
      const write = await request(app)
        .put('/api/v1/auth/mobile')
        .set('Cookie', cookie)
        .send({ mobile: '03001234567' });
      expect(write.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
      expect((await User.findOne({ ajeerCode: a.code }).lean())!.mobile).toBeUndefined();
      // Open while the change is pending: me (to show the screen) and change-password.
      const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
      expect(me.body.user.mustChangePassword).toBe(true);

      // The initial password itself is never accepted as the new one.
      const same = await request(app)
        .post('/api/v1/auth/change-password')
        .set('Cookie', cookie)
        .send({ currentPassword: INITIAL_PASSWORD, newPassword: INITIAL_PASSWORD })
        .expect(400);
      expect(same.body.error.details.reason).toBe('INITIAL_PASSWORD');
      await request(app)
        .post('/api/v1/auth/change-password')
        .set('Cookie', cookie)
        .send({ currentPassword: INITIAL_PASSWORD, newPassword: `naya-${a.code}` })
        .expect(200);

      const after = await User.findOne({ ajeerCode: a.code }).select('+passwordHash').lean();
      expect(after!.mustChangePassword).toBe(false);
      expect(await bcrypt.compare(`naya-${a.code}`, after!.passwordHash)).toBe(true);
      expect(after!.passwordHash).not.toContain(`naya-${a.code}`);

      // Same session, normal role-based access now.
      const { allowed, forbidden } = afterChange(a.role, a.unit);
      for (const path of allowed) {
        const res = await request(app).get(path).set('Cookie', cookie);
        expect(res.status, `${a.role} ${path}`).toBe(200);
      }
      const no = await request(app).get(forbidden).set('Cookie', cookie);
      expect(no.status, `${a.role} ${forbidden}`).toBe(403);
      expect(no.body.error.code).toBe('FORBIDDEN');

      // The old password no longer works; the new one logs in without a change step.
      await login(a.code, INITIAL_PASSWORD).expect(401);
      const again = await login(a.code, `naya-${a.code}`).expect(200);
      expect(again.body.user.mustChangePassword).toBe(false);
    });
  }

  it('a repeated HR import never resets a changed password, nor re-hashes an unchanged one', async () => {
    // A further new employee who has not logged in yet (still on the initial password).
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('HR');
    ws.addRow(HEADER);
    for (const r of ROWS) ws.addRow(r);
    ws.addRow(['860006/1', 'Invented New', 'Ushar', 'Interior Sindh', 'Sukkur', 'Ghotki', '']);
    const again = join(dir, 'hr-again.xlsx');
    await wb.xlsx.writeFile(again);

    await importEmployees(await readEmployeeSheet(again), { dryRun: false });
    const untouched = await User.findOne({ ajeerCode: '860006' }).select('+passwordHash').lean();
    const before = new Map(
      (
        await User.find({ ajeerCode: { $in: ACCOUNTS.map((a) => a.code) } })
          .select('+passwordHash ajeerCode mustChangePassword')
          .lean()
      ).map((u) => [u.ajeerCode, u]),
    );

    const result = await importEmployees(await readEmployeeSheet(again), { dryRun: false });
    expect(result).toMatchObject({ created: 0, updated: 5 });
    for (const a of ACCOUNTS) {
      const u = await User.findOne({ ajeerCode: a.code }).select('+passwordHash').lean();
      expect(u!.passwordHash, a.code).toBe(before.get(a.code)!.passwordHash);
      expect(u!.mustChangePassword, a.code).toBe(false);
      expect(await bcrypt.compare(INITIAL_PASSWORD, u!.passwordHash), a.code).toBe(false);
      await login(a.code, `naya-${a.code}`).expect(200);
    }
    // The never-logged-in account keeps its own hash (not a new one) and still must change it.
    const still = await User.findOne({ ajeerCode: '860006' }).select('+passwordHash').lean();
    expect(still!.passwordHash).toBe(untouched!.passwordHash);
    expect(still!.mustChangePassword).toBe(true);
  });

  it('a dry run never creates an account or sets a password', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('HR');
    ws.addRow(HEADER);
    ws.addRow(['860007/1', 'Invented Dry', 'Ushar', 'Interior Sindh', 'Sukkur', 'Ghotki', '']);
    const dry = join(dir, 'hr-dry.xlsx');
    await wb.xlsx.writeFile(dry);
    const result = await importEmployees(await readEmployeeSheet(dry), { dryRun: true });
    expect(result.created).toBe(1);
    expect(await User.exists({ ajeerCode: '860007' })).toBeNull();
  });
});

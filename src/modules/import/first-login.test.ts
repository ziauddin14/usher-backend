// End to end with invented rows: an HR-imported employee logs in with Ajeer Code + the initial
// password only (no mobile, CTO 7 Nov 2026), is held at "change password" by the API itself, and gets
// normal role-based access only after the change.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../index.js';
import { seedDemo } from '../../seed/seed.js';
import { INITIAL_PASSWORD } from '../auth/schemas.js';
import { importEmployees, readEmployeeSheet } from './employees.js';

const app = createApp();
let dir: string;

describe('HR import → first login → forced password change', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ushr-first-login-'));
    await seedDemo({ reset: true });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employees');
    ws.addRow([
      'Ajeer Code',
      'Naam',
      'Zimmedari',
      'Suba',
      'Division',
      'District',
      'Mobile',
      'Town',
    ]);
    ws.addRow([
      '870001',
      'Invented Employee',
      'Ushar',
      'Interior Sindh',
      'Sukkur',
      'Ghotki',
      '03001119900',
      'Ghotki Town',
    ]);
    // The verified Tehsil parent of that Town (held itself until the Tehsil role exists).
    ws.addRow([
      '870090',
      'Invented Tehsil',
      'Tehsil-Town',
      'Interior Sindh',
      'Sukkur',
      'Ghotki',
      '',
      'Ghotki Town',
    ]);
    const file = join(dir, 'hr.xlsx');
    await wb.xlsx.writeFile(file);
    await importEmployees(await readEmployeeSheet(file), { dryRun: false });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('works only in this order, enforced by the API', async () => {
    expect(INITIAL_PASSWORD).toBe('demo1234');
    const login = (body: object) => request(app).post('/api/v1/auth/login').send(body);
    // Ajeer Code + initial password are enough — no mobile step.
    const ok = await login({ ajeerCode: '870001', password: 'demo1234' }).expect(200);
    expect(ok.body.user.mustChangePassword).toBe(true);
    const cookie = (ok.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

    // Every protected API answers 403 until the password is changed.
    for (const path of [
      '/api/v1/me/summary',
      '/api/v1/villages',
      '/api/v1/jadwals/today',
      '/api/v1/meta',
    ]) {
      const res = await request(app).get(path).set('Cookie', cookie);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }
    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'demo1234', newPassword: 'demo1234' })
      .expect(400);
    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'demo1234', newPassword: 'apna-naya-1' })
      .expect(200);

    await request(app).get('/api/v1/me/summary').set('Cookie', cookie).expect(200);
    // Role-based access stays: a zimmedar cannot open supervisor endpoints.
    await request(app).get('/api/v1/users').set('Cookie', cookie).expect(403);
    // The next login needs only the new password.
    await login({ ajeerCode: '870001', password: 'apna-naya-1' }).expect(200);
    await login({ ajeerCode: '870001', password: 'demo1234' }).expect(401);
  });
});

// Builds a throw-away Excel file with invented rows in the OS temp folder (never in the repo).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOT_CENTRALLY_MANAGED, User } from '../../models/user.js';
import { seedDemo } from '../../seed/seed.js';
import { provisionPakistanAdmin } from '../users/provision.js';
import { importMobiles, readMobileSheet } from './mobiles.js';

let dir: string;
let file: string;

async function addUser(ajeerCode: string, mobile?: string): Promise<void> {
  await User.create({
    ajeerCode,
    name: `Test ${ajeerCode}`,
    role: 'zimmedar',
    zimmedari: 'ushar',
    unitCode: 'GHOTKI',
    unitPath: 'PK/INT_SINDH/SUKKUR/GHOTKI',
    passwordHash: 'x',
    mustChangePassword: true,
    isDemo: false,
    ...(mobile ? { mobile } : {}),
  });
}

describe('mobile import (KPI file)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ushr-mobiles-'));
    await seedDemo({ reset: true });
    await addUser('770001');
    await addUser('770002', '03001110002');
    await addUser('770003', '03001110003');
    await addUser('770004');
    await addUser('770005');

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('KPI');
    ws.addRow(['KPI (test)']);
    ws.addRow(['عملہ کوڈ', 'نام', 'رجسٹرڈ موبائل نمبر']);
    ws.addRow(['770001/1', 'a', '0300-1110001']); // set
    ws.addRow(['770002', 'b', '03001110002']); // same as on record
    ws.addRow(['770003', 'c', '03009990003']); // different → not changed
    ws.addRow(['770004', 'd', '123']); // invalid
    ws.addRow(['770006', 'e', '03001110006']); // no such user
    ws.addRow(['9090412', 'demo', '03001110007']); // demo user → ignored
    file = join(dir, 'kpi.xlsx');
    await wb.xlsx.writeFile(file);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('dry run plans, writes nothing', async () => {
    const result = await importMobiles(await readMobileSheet(file), { dryRun: true });
    expect(result.set).toEqual([{ ajeerCode: '770001', mobile: '03001110001' }]);
    expect(result.unchanged).toBe(1);
    expect(result.different).toEqual([
      { ajeerCode: '770003', onRecord: '03001110003', inFile: '03009990003' },
    ]);
    expect(result.problems.map((p) => p.ajeerCode)).toEqual(['770004', '770006', '9090412']);
    expect(result.stillMissing.map((u) => u.ajeerCode)).toEqual(['770004', '770005']);
    expect((await User.findOne({ ajeerCode: '770001' }).lean())?.mobile).toBeUndefined();
  });

  it('sets only empty numbers (no verification flag any more)', async () => {
    await importMobiles(await readMobileSheet(file), { dryRun: false });
    expect(await User.findOne({ ajeerCode: '770001' }).lean()).toMatchObject({
      mobile: '03001110001',
    });
    expect((await User.findOne({ ajeerCode: '770003' }).lean())?.mobile).toBe('03001110003');
    expect((await User.findOne({ ajeerCode: '9090412' }).lean())?.mobile).toBe('03000000000');
  });
});

describe('mobile import never fills or verifies a Pakistan Admin mobile (CTO 6 Nov 2026)', () => {
  let pdir: string;
  beforeAll(async () => {
    pdir = await mkdtemp(join(tmpdir(), 'ushr-mobiles-pk-'));
    await seedDemo({ reset: true });
    const r = await provisionPakistanAdmin({
      ajeerCode: '771001',
      name: 'Provisioned Admin',
      nominationRef: 'NOM/T/2',
      approvalRef: 'APR/T/2',
      operator: 'Central IT',
    });
    expect(r.ok).toBe(true);
    await addUser('771002');
    // A pakistan account without a provisioning record, and an account with only a department.
    await User.create({
      ajeerCode: '771003',
      name: 'Legacy Pakistan',
      role: 'pakistan',
      unitCode: 'PK',
      unitPath: 'PK',
      passwordHash: 'x',
      isDemo: false,
    });
    await User.create({
      ajeerCode: '771004',
      name: 'Department Only',
      role: 'zimmedar',
      unitCode: 'GHOTKI',
      unitPath: 'PK/INT_SINDH/SUKKUR/GHOTKI',
      passwordHash: 'x',
      department: 'CENTRAL_IT',
      isDemo: false,
    });
  });
  afterAll(async () => {
    await rm(pdir, { recursive: true, force: true });
  });

  it('a provisioned admin in the KPI file keeps no mobile and is not listed as missing', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('KPI');
    ws.addRow(['عملہ کوڈ', 'نام', 'رجسٹرڈ موبائل نمبر']);
    ws.addRow(['771001', 'admin', '03001117001']);
    ws.addRow(['771002', 'zimmedar', '03001117002']);
    ws.addRow(['771003', 'legacy', '03001117003']);
    ws.addRow(['771004', 'dept', '03001117004']);
    const path = join(pdir, 'kpi-pk.xlsx');
    await wb.xlsx.writeFile(path);

    const result = await importMobiles(await readMobileSheet(path), { dryRun: false });
    expect(result.set).toEqual([{ ajeerCode: '771002', mobile: '03001117002' }]);
    expect(result.problems.map((p) => p.ajeerCode)).toEqual(['771001', '771003', '771004']);
    for (const p of result.problems) expect(p.message).toMatch(/never changed by an import/);
    const missing = result.stillMissing.map((u) => u.ajeerCode);
    for (const code of ['771001', '771003', '771004']) expect(missing).not.toContain(code);
    expect(
      await User.countDocuments({
        ajeerCode: { $in: ['771003', '771004'] },
        mobile: { $exists: true },
      }),
    ).toBe(0);
    // The write filter refuses on its own too (in case an account changes during the import).
    const res = await User.updateOne(
      { ajeerCode: '771003', mobile: { $exists: false }, ...NOT_CENTRALLY_MANAGED },
      { $set: { mobile: '03001117003' } },
    );
    expect(res.matchedCount).toBe(0);
    const admin = await User.findOne({ ajeerCode: '771001' }).lean();
    expect(admin!.mobile).toBeUndefined();
  });
});

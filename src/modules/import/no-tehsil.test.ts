import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../models/audit-log.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { seedDemo } from '../../seed/seed.js';
import { migrateNoTehsil } from './no-tehsil.js';

// CTO 13 Nov 2026: a database made under the Tehsil level of 9 Nov 2026 is moved once.
const KHAIRPUR = 'PK/INT_SINDH/SUKKUR/KHAIRPUR';
const TOWN = `${KHAIRPUR}/KHAIRPUR_TOWN`;

beforeAll(async () => {
  await seedDemo({ reset: true });
  // The old shape: a Tehsil unit, its Tehsil account, and Ushar Zimmedaran under it.
  await Unit.create({
    code: 'KHAIRPUR_TOWN',
    name: 'Khairpur Town',
    level: 'tehsil',
    parentCode: 'KHAIRPUR',
    path: TOWN,
    isActive: true,
  });
  await User.updateOne(
    { ajeerCode: '9050001' },
    {
      $set: { role: 'tehsil', unitCode: 'KHAIRPUR_TOWN', unitPath: TOWN },
      $unset: { zimmedari: '' },
    },
  );
  await User.updateMany(
    { role: 'zimmedar', unitCode: 'KHAIRPUR' },
    { $set: { unitCode: 'KHAIRPUR_TOWN', unitPath: TOWN } },
  );
});

describe('migrate to no Tehsil level', () => {
  it('dry run counts and writes nothing; the real run moves everyone to the District', async () => {
    const dry = await migrateNoTehsil({ dryRun: true, operator: 'cli:test' });
    expect(dry.tehsilAccounts).toBe(1);
    expect(dry.zimmedaranMoved).toBeGreaterThanOrEqual(2);
    expect(dry.tehsilUnits).toBe(1);
    expect(await User.countDocuments({ role: 'tehsil' })).toBe(1);

    await migrateNoTehsil({ dryRun: false, operator: 'cli:test' });
    expect(await User.findOne({ ajeerCode: '9050001' }).lean()).toMatchObject({
      role: 'zimmedar',
      zimmedari: 'tehsil_town',
      unitCode: 'KHAIRPUR',
      unitPath: KHAIRPUR,
    });
    expect(await User.countDocuments({ unitPath: TOWN })).toBe(0);
    expect(await Unit.findOne({ code: 'KHAIRPUR_TOWN' }).lean()).toMatchObject({ isActive: false });
    expect(await AuditLog.countDocuments({ action: 'MIGRATE_NO_TEHSIL' })).toBe(1);

    // Again: nothing left to do.
    expect(await migrateNoTehsil({ dryRun: true, operator: 'cli:test' })).toEqual({
      tehsilAccounts: 0,
      zimmedaranMoved: 0,
      tehsilUnits: 0,
    });
  });
});

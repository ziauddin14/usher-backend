import { beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../models/audit-log.js';
import { Donor } from '../../models/donor.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';
import { DistrictNames } from '../../lib/district-names.js';
import { type DonorRow, importDonors } from './donors.js';

// Shoba Ushar's donor list (CTO 12 Nov 2026). All values invented.
const names = new DistrictNames([]);
let district: string; // Ghotki's name as a donor file writes it
let gaon: string; // a Ghotki Gaon
let otherGaon: string;

const row = (n: number, v: DonorRow['values']): DonorRow => ({ row: n, values: v });

beforeAll(async () => {
  await seedDemo({ reset: true });
  await Donor.deleteMany({});
  district = (await Unit.findOne({ code: 'GHOTKI' }).lean())!.name;
  const list = await Village.find({ districtCode: 'GHOTKI', status: 'approved' })
    .sort({ nameKey: 1 })
    .limit(2)
    .lean();
  gaon = list[0]!.name;
  otherGaon = list[1]!.name;
});

describe('donor list import', () => {
  const rows = () => [
    row(2, {
      district,
      code: '9090412',
      village: gaon,
      localName: 'مقامی ذمہ دار',
      localMobile: '0300-1111111',
      donorName: 'ڈونر الف',
      donorMobile: '+92 300 2222222',
      acres: '12',
    }),
    // The same donor again (same Gaon, same mobile): merged.
    row(3, { district, village: gaon, donorName: 'ڈونر الف', donorMobile: '03002222222' }),
    // No mobile: kept by name; a wrong number: imported without it.
    row(4, { district, village: gaon, donorName: 'ڈونر ب' }),
    row(5, { district, village: otherGaon, donorName: 'ڈونر ج', donorMobile: '12345' }),
    // District column unknown → found through the ID's District.
    row(6, { district: 'Nowhere', code: '9090412', village: gaon, donorName: 'ڈونر د' }),
    row(7, { district, village: 'یہ گاؤں نہیں ہے', donorName: 'ڈونر ہ' }),
    row(8, { district: 'Nowhere', village: gaon, donorName: 'ڈونر و' }),
    row(9, { district, village: gaon, donorName: '', donorMobile: '03003333333' }),
  ];

  it('dry run: counts and the report, nothing written', async () => {
    const r = await importDonors(rows(), { dryRun: true, names });
    expect(r).toMatchObject({
      rows: 8,
      donorsInFile: 4,
      repeatedRows: 1,
      created: 4,
      withMobile: 1,
      districtFromId: 1,
      localZimmedarSet: 1,
    });
    expect(r.villageNotFound.map((x) => x.row)).toEqual([7]);
    expect(r.districtNotFound.map((x) => x.row)).toEqual([8]);
    expect(r.noDonorName.map((x) => x.row)).toEqual([9]);
    expect(r.badMobile.map((x) => x.row)).toEqual([5]);
    expect(await Donor.countDocuments()).toBe(0);
  });

  it('real run: donors per Gaon, the local zimmedar on the Gaon, audited; again = unchanged', async () => {
    const r = await importDonors(rows(), {
      dryRun: false,
      names,
      source: { file: 'donors.csv', operator: 'cli:test' },
    });
    expect(r).toMatchObject({ created: 4, updated: 0 });
    const v = await Village.findOne({ districtCode: 'GHOTKI', name: gaon }).lean();
    expect(v!.localZimmedar).toEqual({ name: 'مقامی ذمہ دار', mobile: '03001111111' });
    const alif = await Donor.findOne({ villageId: v!._id, mobile: '03002222222' }).lean();
    expect(alif).toMatchObject({
      name: 'ڈونر الف',
      acres: 12,
      meetings: 0,
      source: { kind: 'import', file: 'donors.csv', row: 2 },
    });
    expect(await AuditLog.countDocuments({ action: 'IMPORT_DONORS' })).toBe(1);

    const again = await importDonors(rows(), { dryRun: false, names });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 4 });
    expect(await Donor.countDocuments()).toBe(4);
  });

  it('a Gaon of another District is never matched', async () => {
    const larkana = await Unit.findOne({ level: 'district', code: { $ne: 'GHOTKI' } }).lean();
    const r = await importDonors(
      [row(2, { district: larkana!.name, village: gaon, donorName: 'ڈونر ز' })],
      { dryRun: true, names },
    );
    // Unless the other District happens to have a Gaon of the same name.
    const same = await Village.countDocuments({ unitPath: larkana!.path, name: gaon });
    expect(r.villageNotFound.length).toBe(same > 0 ? 0 : 1);
    expect(await User.countDocuments({ ajeerCode: '9090412' })).toBe(1);
  });
});

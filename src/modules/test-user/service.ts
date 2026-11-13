// Test-mode Ushar Zimmedar (CTO 13 Nov 2026): a real account in the live app that works exactly like
// any zimmedar, but lives in its own sandbox unit TEST (outside PK). Every report, dashboard, ERP
// view and import is scoped under PK, so nothing he does is ever counted. His own Gaon and donors
// are test ones; his test data older than today is cleared at each login, and on request.
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';
import { villageNameKey } from '../../lib/text.js';
import { karachiDate } from '../../lib/time.js';
import { Donor } from '../../models/donor.js';
import { Jadwal } from '../../models/jadwal.js';
import { Pledge } from '../../models/pledge.js';
import { Unit } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { BCRYPT_COST } from '../auth/service.js';

/** The sandbox: same depth as PK/<suba>/<division>/<district>, never under PK. */
export const TEST_UNITS = [
  {
    code: 'TEST',
    name: 'UsherDesk Test',
    nameUr: 'ٹیسٹ',
    level: 'pakistan',
    parentCode: null,
    path: 'TEST',
  },
  {
    code: 'TEST_SUBA',
    name: 'Test Suba',
    nameUr: 'ٹیسٹ صوبہ',
    level: 'suba',
    parentCode: 'TEST',
    path: 'TEST/TEST_SUBA',
  },
  {
    code: 'TEST_DIV',
    name: 'Test Division',
    nameUr: 'ٹیسٹ ڈویژن',
    level: 'division',
    parentCode: 'TEST_SUBA',
    path: 'TEST/TEST_SUBA/TEST_DIV',
  },
  {
    code: 'TEST_DIST',
    name: 'Test District',
    nameUr: 'ٹیسٹ ضلع',
    level: 'district',
    parentCode: 'TEST_DIV',
    path: 'TEST/TEST_SUBA/TEST_DIV/TEST_DIST',
  },
] as const;
export const TEST_DISTRICT_PATH = 'TEST/TEST_SUBA/TEST_DIV/TEST_DIST';
/** Nine digits: no HR Ajeer Code is that long. */
export const TEST_AJEER_CODE = '999999001';
const TEST_GAON = ['ٹیسٹ گاؤں ایک', 'ٹیسٹ گاؤں دو', 'ٹیسٹ گاؤں تین'];
const INITIAL_PASSWORD = 'demo1234';

/**
 * Create (or complete) the sandbox units, the test zimmedar (initial password, must change it),
 * three test Gaon with invented donors and a local zimmedar. Idempotent; never touches a unit,
 * user, Gaon or donor outside TEST. `dryRun` only reports what would be created.
 */
export async function provisionTestUser({
  dryRun,
  operator,
}: {
  dryRun: boolean;
  operator: string;
}): Promise<{ units: number; user: 'created' | 'exists'; gaon: number; donors: number }> {
  const clash = await User.findOne({ ajeerCode: TEST_AJEER_CODE, isTest: { $ne: true } }).lean();
  if (clash) throw new Error(`Ajeer code ${TEST_AJEER_CODE} belongs to a real account — stopping`);
  const existingUser = await User.findOne({ ajeerCode: TEST_AJEER_CODE }).lean();
  const result = {
    units: TEST_UNITS.length,
    user: existingUser ? ('exists' as const) : ('created' as const),
    gaon: TEST_GAON.length,
    donors: TEST_GAON.length * 3,
  };
  if (dryRun) return result;

  for (const u of TEST_UNITS) {
    await Unit.updateOne({ code: u.code }, { $set: { ...u, isActive: true } }, { upsert: true });
  }
  const user = await User.findOneAndUpdate(
    { ajeerCode: TEST_AJEER_CODE },
    {
      $set: {
        name: 'Test Ushar Zimmedar',
        nameUr: 'ٹیسٹ عشر ذمہ دار',
        role: 'zimmedar',
        zimmedari: 'ushar',
        unitCode: 'TEST_DIST',
        unitPath: TEST_DISTRICT_PATH,
        isActive: true,
        isTest: true,
      },
      $setOnInsert: {
        passwordHash: await bcrypt.hash(INITIAL_PASSWORD, BCRYPT_COST),
        mustChangePassword: true,
      },
    },
    { upsert: true, new: true },
  ).lean();
  const now = new Date();
  for (const [gi, name] of TEST_GAON.entries()) {
    const nameKey = villageNameKey(name);
    const v = await Village.findOneAndUpdate(
      { unitPath: TEST_DISTRICT_PATH, nameKey, status: { $in: ['approved', 'pending'] } },
      {
        $set: {
          assignedTo: user._id,
          localZimmedar: { name: 'ٹیسٹ مقامی ذمہ دار', mobile: '03000000000' },
        },
        $setOnInsert: {
          name,
          nameKey,
          districtCode: 'TEST_DIST',
          unitPath: TEST_DISTRICT_PATH,
          status: 'approved',
          source: { kind: 'district', at: now },
        },
      },
      { upsert: true, new: true },
    ).lean();
    for (let n = 1; n <= 3; n += 1) {
      const donor = `ٹیسٹ ڈونر ${gi * 3 + n}`;
      const mobile = `0399999${String(gi * 10 + n).padStart(4, '0')}`;
      await Donor.updateOne(
        { villageId: v._id, mobile },
        {
          $setOnInsert: {
            villageId: v._id,
            unitPath: TEST_DISTRICT_PATH,
            name: donor,
            nameKey: villageNameKey(donor),
            mobile,
            acres: 5 * n,
            addedOn: '2026-01-01',
            source: { kind: 'import', file: 'test-user', at: now },
            meetings: 0,
            isActive: true,
          },
        },
        { upsert: true },
      );
    }
  }
  if (result.user === 'created') {
    await audit({
      action: 'USER_PROVISION',
      actorAjeerCode: operator,
      targetType: 'user',
      targetId: String(user._id),
      unitPath: TEST_DISTRICT_PATH,
      details: { kind: 'test-zimmedar', ajeerCode: TEST_AJEER_CODE },
    });
  }
  return result;
}

/**
 * Clear a test zimmedar's test data: his jadwals and niyyat (all, or only before `before`), the
 * donors he added, the meetings recorded on the test donors, and his Gaon additions. Audit entries
 * are kept. Refuses for any account that is not a test account in the TEST sandbox.
 */
export async function resetTestData(user: Pick<AuthUser, 'id' | 'unitPath'>, before?: string) {
  const u = await User.findById(user.id).select('isTest unitPath').lean();
  if (!u?.isTest || !u.unitPath.startsWith('TEST/')) {
    throw new AppError(403, 'FORBIDDEN', 'Only a test account can clear its data');
  }
  const userId = new Types.ObjectId(user.id);
  const dated = before ? { date: { $lt: before } } : {};
  const jadwals = await Jadwal.find({ userId, ...dated })
    .select('_id')
    .lean();
  const ids = jadwals.map((j) => j._id);
  const [j, p, d] = await Promise.all([
    Jadwal.deleteMany({ _id: { $in: ids } }),
    Pledge.deleteMany({ userId, unitPath: { $regex: '^TEST/' }, jadwalId: { $in: ids } }),
    Donor.deleteMany({
      unitPath: { $regex: '^TEST/' },
      'source.kind': 'zimmedar',
      'source.jadwalId': { $in: ids },
    }),
  ]);
  // Meetings recorded by the removed days no longer count on the test donors.
  await Donor.updateMany(
    { unitPath: { $regex: '^TEST/' }, 'lastMet.jadwalId': { $in: ids } },
    { $set: { meetings: 0 }, $unset: { lastMet: '' } },
  );
  if (!before) {
    await Donor.updateMany(
      { unitPath: { $regex: '^TEST/' } },
      { $set: { meetings: 0 }, $unset: { lastMet: '' } },
    );
    await Village.deleteMany({
      unitPath: { $regex: '^TEST/' },
      addedBy: userId,
      'source.kind': 'zimmedar',
    });
  }
  return { jadwals: j.deletedCount, pledges: p.deletedCount, donors: d.deletedCount };
}

/** At login: a test account starts each day clean (test data of earlier days removed). */
export async function resetTestDataAtLogin(user: {
  _id: Types.ObjectId;
  isTest?: boolean | null;
  unitPath: string;
}) {
  if (!user.isTest) return;
  await resetTestData({ id: String(user._id), unitPath: user.unitPath }, karachiDate());
}

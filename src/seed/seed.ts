import bcrypt from 'bcryptjs';
import { connectDb } from '../lib/db.js';
import { clearSettingsCache } from '../lib/settings.js';
import { villageNameKey } from '../lib/text.js';
import { AuditLog } from '../models/audit-log.js';
import { Jadwal } from '../models/jadwal.js';
import { Setting } from '../models/setting.js';
import { Unit } from '../models/unit.js';
import { User } from '../models/user.js';
import { Village } from '../models/village.js';
import { BCRYPT_COST } from '../modules/auth/service.js';
import { DEFAULT_SETTINGS } from '../modules/settings/defaults.js';
import {
  DEMO_PASSWORD,
  DEMO_USERS,
  seedUnits,
  seedVillageNames,
  seedZimmedaran,
  type SeedUser,
} from './data.js';

const ALL_MODELS = [Unit, User, Village, Jadwal, Setting, AuditLog] as const;

const LIVE_STATUSES: ('approved' | 'pending')[] = ['approved', 'pending'];

export interface SeedResult {
  units: number;
  users: number;
  villages: number;
}

/**
 * Idempotent demo seed: units, settings, users, villages.
 * Existing passwords and edited settings are kept; `reset` wipes the demo collections first.
 */
export async function seedDemo({ reset = false } = {}): Promise<SeedResult> {
  await connectDb();

  if (reset) {
    await Promise.all([
      Unit.deleteMany(),
      User.deleteMany(),
      Village.deleteMany(),
      Jadwal.deleteMany(),
      Setting.deleteMany(),
      AuditLog.deleteMany(),
    ]);
    clearSettingsCache();
  }
  await Promise.all(ALL_MODELS.map((m) => m.init())); // build indexes

  // Units with materialised paths (parents come before children in seedUnits()).
  const units = seedUnits();
  const paths = new Map<string, string>();
  for (const u of units) {
    const path = u.parentCode ? `${paths.get(u.parentCode)!}/${u.code}` : u.code;
    paths.set(u.code, path);
  }
  await Unit.bulkWrite(
    units.map((u) => ({
      updateOne: {
        filter: { code: u.code },
        update: { $set: { ...u, path: paths.get(u.code)!, isActive: true } },
        upsert: true,
      },
    })),
  );

  await Setting.updateOne({ _id: 'app' }, { $setOnInsert: DEFAULT_SETTINGS }, { upsert: true });
  clearSettingsCache();

  // Users. One hash for the shared demo password keeps the seed fast.
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST);
  const districts = units.filter((u) => u.level === 'district').map((u) => u.code);
  const users: SeedUser[] = [...DEMO_USERS, ...seedZimmedaran(districts)];
  await User.bulkWrite(
    users.map((u) => ({
      updateOne: {
        filter: { ajeerCode: u.ajeerCode },
        update: {
          $set: { ...u, unitPath: paths.get(u.unitCode)!, isDemo: true, isActive: true },
          // Forced password change is disabled for demo users (scope §6).
          $setOnInsert: { passwordHash, mustChangePassword: false },
        },
        upsert: true,
      },
    })),
  );

  // Approved villages per district.
  const villageOps = districts.flatMap((code, i) =>
    seedVillageNames(code, i).map((name) => {
      const nameKey = villageNameKey(name);
      const unitPath = paths.get(code)!;
      return {
        updateOne: {
          filter: { unitPath, nameKey, status: { $in: LIVE_STATUSES } },
          update: {
            $setOnInsert: {
              name,
              nameKey,
              districtCode: code,
              unitPath,
              status: 'approved' as const,
            },
          },
          upsert: true,
        },
      };
    }),
  );
  await Village.bulkWrite(villageOps);

  // TODO(Step 3): seed jadwal history 1 Jun 2026 → yesterday (data model "Seed" → Jadwals),
  // including the exact monthly reward-wusooli for 90412.

  return { units: units.length, users: users.length, villages: villageOps.length };
}

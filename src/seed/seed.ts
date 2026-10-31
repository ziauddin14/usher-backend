import type { Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { connectDb } from '../lib/db.js';
import { clearSettingsCache, ensureSettings } from '../lib/settings.js';
import { villageNameKey } from '../lib/text.js';
import { AuditLog } from '../models/audit-log.js';
import { Jadwal } from '../models/jadwal.js';
import { PasswordResetRequest } from '../models/password-reset-request.js';
import { Setting } from '../models/setting.js';
import { Unit } from '../models/unit.js';
import { User } from '../models/user.js';
import { Village } from '../models/village.js';
import { BCRYPT_COST } from '../modules/auth/service.js';
import {
  DEMO_PASSWORD,
  DEMO_USERS,
  seedUnits,
  seedVillageNames,
  seedZimmedaran,
  type SeedUser,
} from './data.js';

const ALL_MODELS = [Unit, User, Village, Jadwal, Setting, AuditLog, PasswordResetRequest] as const;

/** Invented demo mobile (CLAUDE.md rule 11) so reset / forgot-password can be tried on demo users. */
const DEMO_MOBILE = '03000000000';

const LIVE_STATUSES: ('approved' | 'pending')[] = ['approved', 'pending'];

/**
 * Like the real village list: every approved village belongs to one Ushar Zimmedar of its
 * district. Round-robin in name order (the demo zimmedar 9090412 first); villages that already
 * have someone keep them.
 */
async function assignSeedVillages(): Promise<void> {
  const zimmedaran = await User.find({ role: 'zimmedar', isDemo: true })
    .select('_id ajeerCode unitPath')
    .sort({ ajeerCode: 1 })
    .lean();
  const byDistrict = new Map<string, typeof zimmedaran>();
  for (const z of zimmedaran) {
    const list = byDistrict.get(z.unitPath) ?? [];
    if (z.ajeerCode === '9090412') list.unshift(z);
    else list.push(z);
    byDistrict.set(z.unitPath, list);
  }
  const ops: {
    updateOne: {
      filter: { _id: Types.ObjectId };
      update: { $set: { assignedTo: Types.ObjectId } };
    };
  }[] = [];
  for (const [unitPath, list] of byDistrict) {
    const villages = await Village.find({ unitPath, status: 'approved' })
      .select('_id assignedTo')
      .sort({ nameKey: 1 })
      .lean();
    // The demo zimmedar gets 5 villages (as in design A4); the rest are shared round-robin.
    const demoFirst = list[0]?.ajeerCode === '9090412' && list.length > 1;
    villages.forEach((v, i) => {
      const owner = demoFirst
        ? i < 5
          ? list[0]!
          : list[1 + ((i - 5) % (list.length - 1))]!
        : list[i % list.length]!;
      if (!v.assignedTo) {
        ops.push({
          updateOne: { filter: { _id: v._id }, update: { $set: { assignedTo: owner._id } } },
        });
      }
    });
  }
  if (ops.length > 0) await Village.bulkWrite(ops);
}

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
      PasswordResetRequest.deleteMany(),
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

  await ensureSettings();

  // Users. One hash for the shared demo password keeps the seed fast.
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST);
  const districts = units.filter((u) => u.level === 'district').map((u) => u.code);
  const users: SeedUser[] = [...DEMO_USERS, ...seedZimmedaran(districts)];
  await User.bulkWrite(
    users.map((u) => ({
      updateOne: {
        filter: { ajeerCode: u.ajeerCode },
        update: {
          $set: {
            ...u,
            unitPath: paths.get(u.unitCode)!,
            mobile: DEMO_MOBILE,
            isDemo: true,
            isActive: true,
          },
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
  await assignSeedVillages();

  // TODO(Step 3): seed jadwal history 1 Jun 2026 → yesterday (data model "Seed" → Jadwals),
  // including the exact monthly reward-wusooli for 9090412.

  return { units: units.length, users: users.length, villages: villageOps.length };
}

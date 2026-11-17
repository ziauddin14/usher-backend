// A Gaon's information (CTO 17 Nov 2026): its location, its crops and its local zimmedar (the
// permanent person of the Gaon, so a new Ushar Zimmedar knows whom to contact). The Ushar Zimmedar
// of the Gaon fills an empty field once; after that only the Admin changes it. Every change is
// audited (VILLAGE_INFO); mobiles in the audit are masked.
import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { type AuthUser, EDITOR_ROLES } from '../../lib/auth.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { maskMobile, normalizeMobile } from '../../lib/mobile.js';
import { assertInScope } from '../../lib/scope.js';
import { getCrops } from '../../lib/settings.js';
import { OTHER_CROP } from '../settings/crops.js';
import { Village } from '../../models/village.js';
import { findUsableVillage } from './service.js';
import type { VillageInfoInput } from './schemas.js';

interface StoredInfo {
  localZimmedar?: { name?: string | null; mobile?: string | null } | null;
  crops?: string[] | null;
  cropsOther?: string | null;
  location?: { lat: number; lng: number; accuracy?: number | null; source: string } | null;
}

/** The Gaon's information as the screens show it. */
export function infoOf(v: StoredInfo) {
  const lz = v.localZimmedar;
  return {
    localZimmedar:
      lz?.name || lz?.mobile ? { name: lz.name ?? null, mobile: lz.mobile ?? null } : null,
    crops: v.crops ?? [],
    cropsOther: v.cropsOther ?? null,
    location: v.location
      ? {
          lat: v.location.lat,
          lng: v.location.lng,
          accuracy: v.location.accuracy ?? null,
          source: v.location.source as 'gps' | 'admin',
        }
      : null,
  };
}

/** Text of a mobile for an audit entry: masked, never the full number. */
const auditView = (info: ReturnType<typeof infoOf>) => ({
  localZimmedar: info.localZimmedar
    ? { name: info.localZimmedar.name, mobile: maskMobile(info.localZimmedar.mobile) }
    : null,
  crops: info.crops,
  cropsOther: info.cropsOther,
  location: info.location ? { lat: info.location.lat, lng: info.location.lng } : null,
});

const blank = (s: string | null | undefined) => !s || !s.trim();

/**
 * PATCH /villages/:id/info. Zimmedar: only his own Gaon, only empty fields (else
 * 409 VILLAGE_INFO_SET), never a clear. Admin: any Gaon in scope, fill, change or clear (null).
 */
export async function updateVillageInfo(caller: AuthUser, id: string, input: VillageInfoInput) {
  await connectDb();
  const isAdmin = EDITOR_ROLES.includes(caller.role);
  if (!isAdmin && caller.role !== 'zimmedar') {
    throw new AppError(403, 'FORBIDDEN', 'Not allowed for this role');
  }
  if (!isAdmin && !(await findUsableVillage(caller, id))) {
    throw new AppError(404, 'NOT_FOUND', 'Village not found');
  }
  const village = Types.ObjectId.isValid(id)
    ? await Village.findOne({ _id: id, status: { $in: ['approved', 'pending'] } })
        .select('name unitPath localZimmedar crops cropsOther location')
        .lean()
    : null;
  assertInScope(caller, village);
  const before = infoOf(village);

  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  const taken: string[] = [];

  if (input.localZimmedar) {
    const { name, mobile } = input.localZimmedar;
    if (name !== undefined) {
      if (!isAdmin && (name === null || !blank(village.localZimmedar?.name))) taken.push('name');
      else if (blank(name)) unset['localZimmedar.name'] = 1;
      else set['localZimmedar.name'] = name!.replace(/\s+/g, ' ').trim();
    }
    if (mobile !== undefined) {
      if (!isAdmin && (mobile === null || !blank(village.localZimmedar?.mobile))) {
        taken.push('mobile');
      } else if (blank(mobile)) unset['localZimmedar.mobile'] = 1;
      else {
        const m = normalizeMobile(mobile);
        if (!m) throw new AppError(400, 'VALIDATION_FAILED', 'Not a mobile number');
        set['localZimmedar.mobile'] = m;
      }
    }
  }

  if (input.crops !== undefined) {
    if (!isAdmin && (input.crops === null || (village.crops ?? []).length > 0)) taken.push('crops');
    else if (!input.crops?.length) {
      unset.crops = 1;
      unset.cropsOther = 1;
    } else {
      const known = new Set((await getCrops()).map((c) => c.id));
      const bad = input.crops.filter((c) => !known.has(c));
      if (bad.length) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Unknown crop', { crops: bad });
      }
      set.crops = [...new Set(input.crops)];
      const other = input.cropsOther?.replace(/\s+/g, ' ').trim();
      if (input.crops.includes(OTHER_CROP) && other) set.cropsOther = other;
      else unset.cropsOther = 1;
    }
  }

  if (input.location !== undefined) {
    if (!isAdmin && (input.location === null || village.location)) taken.push('location');
    else if (input.location === null) unset.location = 1;
    else {
      set.location = {
        lat: input.location.lat,
        lng: input.location.lng,
        ...(input.location.accuracy !== undefined
          ? { accuracy: Math.round(input.location.accuracy) }
          : {}),
        source: isAdmin ? 'admin' : 'gps',
        by: new Types.ObjectId(caller.id),
        at: new Date(),
      };
    }
  }

  if (taken.length) {
    throw new AppError(409, 'VILLAGE_INFO_SET', 'Already filled — only the Admin changes it', {
      fields: taken,
    });
  }
  const update: Record<string, unknown> = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  if (!Object.keys(update).length) return before;

  const after = await Village.findOneAndUpdate({ _id: village._id }, update, {
    returnDocument: 'after',
  })
    .select('localZimmedar crops cropsOther location')
    .lean();
  const info = infoOf(after ?? {});
  await audit({
    action: 'VILLAGE_INFO',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'village',
    targetId: String(village._id),
    unitPath: village.unitPath,
    details: { name: village.name, before: auditView(before), after: auditView(info) },
  });
  return info;
}

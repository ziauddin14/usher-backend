// E-Raseed (ERP) receipts (CTO 11 Nov 2026): the Pakistan level uploads the ERP's daily file;
// every level then sees what each zimmedar's receipts brought in, by Gaon and by mad. The ERP is
// the source of truth for these details — nothing here is typed by a zimmedar.
import { Types } from 'mongoose';
import type { AuthUser } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { districtPathOf, escapeRegex } from '../../lib/scope.js';
import { getRewardRules, getSettings } from '../../lib/settings.js';
import { villageNameKey } from '../../lib/text.js';
import { karachiDate } from '../../lib/time.js';
import { ErpReceipt, ErpUpload } from '../../models/erp-receipt.js';
import { Unit, type UnitLevel } from '../../models/unit.js';
import { User } from '../../models/user.js';
import { Village } from '../../models/village.js';
import { unitInScope } from '../dash/service.js';
import type { SummaryPeriod } from '../me/schemas.js';
import { periodRange } from '../me/service.js';
import {
  checkErpRows,
  ErpFileError,
  type ErpLine,
  type ErpRowError,
  type ErpRowReason,
  readErpTable,
} from './parse.js';

/** Row errors returned to the screen (the counts per reason always cover all of them). */
const MAX_ERRORS_SHOWN = 500;

interface Resolved extends ErpLine {
  userId: Types.ObjectId;
  unitPath: string;
  villageId?: Types.ObjectId;
}

type Change = 'added' | 'updated' | 'unchanged';

const COMPARED = [
  'date',
  'ajeerCode',
  'villageName',
  'kind',
  'amount',
  'mad',
  'item',
  'qty',
  'qtyUnit',
  'cancelled',
] as const;

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/**
 * Gaon of each line: a Gaon of the zimmedar's own District with the same name key, the one
 * assigned to him first; none when the name is missing, unknown or ambiguous (the line still
 * counts for the zimmedar — only the Gaon link is left out).
 */
async function matchVillages(lines: Resolved[]): Promise<void> {
  const keys = [
    ...new Set(lines.flatMap((l) => (l.villageName ? [villageNameKey(l.villageName)] : []))),
  ];
  if (keys.length === 0) return;
  const villages = await Village.find({ nameKey: { $in: keys }, status: { $ne: 'merged' } })
    .select('_id nameKey unitPath assignedTo')
    .lean();
  const byKey = new Map<string, typeof villages>();
  for (const v of villages) byKey.set(v.nameKey, [...(byKey.get(v.nameKey) ?? []), v]);
  for (const line of lines) {
    if (!line.villageName) continue;
    const district = districtPathOf(line.unitPath);
    if (!district) continue;
    const inDistrict = (byKey.get(villageNameKey(line.villageName)) ?? []).filter(
      (v) => v.unitPath === district || v.unitPath.startsWith(`${district}/`),
    );
    const own = inDistrict.filter((v) => v.assignedTo && v.assignedTo.equals(line.userId));
    const pick = own.length === 1 ? own[0] : inDistrict.length === 1 ? inDistrict[0] : undefined;
    if (pick) line.villageId = pick._id;
  }
}

function fileError(error: unknown): never {
  if (error instanceof ErpFileError) {
    throw new AppError(400, 'VALIDATION_FAILED', `ERP file: ${error.problem}`, {
      reason: `ERP_FILE_${error.problem}`,
      ...(error.missing.length ? { missing: error.missing } : {}),
    });
  }
  throw error;
}

/**
 * POST /erp/uploads — check the file (preview) or check and save it (commit). Saving is by
 * (receiptNo, lineNo): the same file twice adds nothing; a changed line (e.g. now cancelled) is
 * updated. Rows with an error are never saved.
 */
export async function erpUpload(
  caller: AuthUser,
  bytes: Buffer,
  fileName: string,
  commit: boolean,
) {
  await connectDb();
  const today = karachiDate();
  let checked: ReturnType<typeof checkErpRows>;
  try {
    checked = checkErpRows(await readErpTable(bytes), today);
  } catch (error) {
    fileError(error);
  }
  const errors: ErpRowError[] = [...checked.errors];

  const codes = [...new Set(checked.lines.map((l) => l.ajeerCode))];
  const users = await User.find({ ajeerCode: { $in: codes } })
    .select('_id ajeerCode unitPath')
    .lean();
  const userBy = new Map(users.map((u) => [u.ajeerCode, u]));
  const lines: Resolved[] = [];
  for (const line of checked.lines) {
    const user = userBy.get(line.ajeerCode);
    if (!user) errors.push({ row: line.row, reason: 'AJEER_CODE_UNKNOWN' });
    else lines.push({ ...line, userId: user._id, unitPath: user.unitPath });
  }
  await matchVillages(lines);

  const existing = await ErpReceipt.find({
    receiptNo: { $in: [...new Set(lines.map((l) => l.receiptNo))] },
  })
    .select('receiptNo lineNo userId unitPath villageId ' + COMPARED.join(' '))
    .lean();
  const existingBy = new Map(existing.map((e) => [`${e.receiptNo}\u0000${e.lineNo}`, e]));
  const changes = lines.map((l): { line: Resolved; change: Change; keepPath?: string } => {
    const old = existingBy.get(`${l.receiptNo}\u0000${l.lineNo}`);
    if (!old) return { line: l, change: 'added' };
    const differs =
      COMPARED.some((k) => !same(old[k], l[k])) ||
      !old.userId.equals(l.userId) ||
      String(old.villageId ?? '') !== String(l.villageId ?? '');
    // A line keeps the unit it was first saved under while it stays with the same zimmedar.
    const keepPath = old.userId.equals(l.userId) ? old.unitPath : undefined;
    return {
      line: l,
      change: differs ? 'updated' : 'unchanged',
      ...(keepPath ? { keepPath } : {}),
    };
  });

  const active = lines.filter((l) => !l.cancelled);
  const dates = lines.map((l) => l.date).sort();
  const count = (c: Change) => changes.filter((x) => x.change === c).length;
  const byReason: Partial<Record<ErpRowReason, number>> = {};
  for (const e of errors) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
  errors.sort((a, b) => a.row - b.row);

  const result = {
    fileName,
    rows: checked.rows,
    valid: lines.length,
    rejected: errors.length,
    added: count('added'),
    updated: count('updated'),
    unchanged: count('unchanged'),
    cancelled: lines.length - active.length,
    naqd: active.filter((l) => l.kind === 'naqd').reduce((s, l) => s + l.amount, 0),
    jins: active.filter((l) => l.kind === 'jins').reduce((s, l) => s + l.amount, 0),
    zimmedaran: new Set(lines.map((l) => l.ajeerCode)).size,
    gaonMatched: lines.filter((l) => l.villageId).length,
    gaonUnmatched: lines.filter((l) => !l.villageId).length,
    dateFrom: dates[0] ?? null,
    dateTo: dates.at(-1) ?? null,
    errorsByReason: byReason,
    errors: errors.slice(0, MAX_ERRORS_SHOWN),
    committed: false,
  };
  if (!commit) return result;

  if (lines.length === 0) {
    throw new AppError(400, 'VALIDATION_FAILED', 'The file has no valid row to save', {
      reason: 'ERP_NOTHING_TO_SAVE',
    });
  }
  const upload = await ErpUpload.create({
    fileName,
    by: new Types.ObjectId(caller.id),
    byAjeerCode: caller.ajeerCode,
    at: new Date(),
    rows: result.rows,
    added: result.added,
    updated: result.updated,
    unchanged: result.unchanged,
    rejected: result.rejected,
    ...(result.dateFrom ? { dateFrom: result.dateFrom, dateTo: result.dateTo } : {}),
  });
  const writes = changes
    .filter((c) => c.change !== 'unchanged')
    .map(({ line, keepPath }) => {
      const { row: _row, ...data } = line;
      const doc: Record<string, unknown> = {
        ...data,
        unitPath: keepPath ?? line.unitPath,
        month: line.date.slice(0, 7),
        uploadId: upload._id,
      };
      const unset: Record<string, ''> = {};
      for (const k of ['villageName', 'villageId', 'mad', 'item', 'qty', 'qtyUnit'] as const) {
        if (doc[k] === undefined) {
          delete doc[k];
          unset[k] = '';
        }
      }
      return {
        updateOne: {
          filter: { receiptNo: line.receiptNo, lineNo: line.lineNo },
          update: { $set: doc, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
          upsert: true,
        },
      };
    });
  for (let i = 0; i < writes.length; i += 1000) {
    await ErpReceipt.bulkWrite(writes.slice(i, i + 1000), { ordered: false });
  }
  await audit({
    action: 'ERP_UPLOAD',
    actorId: caller.id,
    actorAjeerCode: caller.ajeerCode,
    targetType: 'erpUpload',
    targetId: String(upload._id),
    unitPath: caller.unitPath,
    details: {
      fileName,
      rows: result.rows,
      added: result.added,
      updated: result.updated,
      unchanged: result.unchanged,
      rejected: result.rejected,
      dateFrom: result.dateFrom,
      dateTo: result.dateTo,
    },
  });
  return { ...result, committed: true, uploadId: String(upload._id) };
}

/** GET /erp/uploads — the latest confirmed uploads (counts only). */
export async function recentUploads() {
  await connectDb();
  const uploads = await ErpUpload.find()
    .sort({ at: -1, _id: -1 })
    .limit(20)
    .select('fileName byAjeerCode at rows added updated unchanged rejected dateFrom dateTo')
    .lean();
  return {
    uploads: uploads.map(({ _id, ...u }) => ({
      id: String(_id),
      ...u,
      dateFrom: u.dateFrom ?? null,
      dateTo: u.dateTo ?? null,
    })),
  };
}

// ---- Reports ----

interface Sums {
  entries: number;
  receipts: number;
  naqd: number;
  jins: number;
}

const sumStages = {
  entries: { $sum: 1 },
  receipts: { $addToSet: '$receiptNo' },
  naqd: { $sum: { $cond: [{ $eq: ['$kind', 'naqd'] }, '$amount', 0] } },
  jins: { $sum: { $cond: [{ $eq: ['$kind', 'jins'] }, '$amount', 0] } },
};

const emptySums = (): Sums => ({ entries: 0, receipts: 0, naqd: 0, jins: 0 });

function sumsOf(r: { entries: number; receipts: unknown[]; naqd: number; jins: number }): Sums {
  return { entries: r.entries, receipts: r.receipts.length, naqd: r.naqd, jins: r.jins };
}

async function range(period: SummaryPeriod, date: string | undefined, from: string | undefined) {
  const settings = await getSettings();
  const today = karachiDate();
  const day = date && date < today ? date : today;
  const r = periodRange(period, day, today, settings.weekStartsOn, await getRewardRules(), from);
  return { ...r, date: day, today, period };
}

async function byMad(match: Record<string, unknown>) {
  const rows = await ErpReceipt.aggregate<{
    _id: string | null;
    entries: number;
    receipts: unknown[];
    naqd: number;
    jins: number;
  }>([{ $match: match }, { $group: { _id: '$mad', ...sumStages } }]);
  return rows
    .map((r) => ({ mad: r._id ?? null, ...sumsOf(r) }))
    .sort((a, b) => b.naqd + b.jins - (a.naqd + a.jins));
}

async function lastUpload() {
  const u = await ErpUpload.findOne().sort({ at: -1, _id: -1 }).select('at dateTo').lean();
  return u ? { at: u.at, dateTo: u.dateTo ?? null } : null;
}

const LEVEL_ORDER: UnitLevel[] = ['pakistan', 'suba', 'division', 'district', 'tehsil'];

/**
 * GET /dash/units/:code/erp — ERP receipts of a unit in a period: totals, by mad, and one row per
 * child unit (Pakistan … Division) or per zimmedar (District, Tehsil). Cancelled lines never count.
 */
export async function unitErp(
  caller: AuthUser,
  code: string,
  q: { period: SummaryPeriod; date?: string | undefined; from?: string | undefined },
) {
  await connectDb();
  const unit = await unitInScope(caller, code);
  const span = await range(q.period, q.date, q.from);
  const match = {
    unitPath: { $regex: `^${escapeRegex(unit.path)}(/|$)` },
    date: { $gte: span.from, $lte: span.to },
    cancelled: false,
  };
  const [perUser, mads, last] = await Promise.all([
    ErpReceipt.aggregate<{
      _id: { u: Types.ObjectId; p: string };
      entries: number;
      receipts: unknown[];
      naqd: number;
      jins: number;
    }>([{ $match: match }, { $group: { _id: { u: '$userId', p: '$unitPath' }, ...sumStages } }]),
    byMad(match),
    lastUpload(),
  ]);

  const totals = emptySums();
  const receiptSet = new Set<string>();
  for (const r of perUser) {
    totals.entries += r.entries;
    totals.naqd += r.naqd;
    totals.jins += r.jins;
    for (const no of r.receipts) receiptSet.add(String(no));
  }
  totals.receipts = receiptSet.size;

  const base = { unit, ...span, totals, byMad: mads, lastUpload: last };
  if (unit.level === 'district' || unit.level === 'tehsil') {
    // Every active zimmedar of the unit is listed (0 = no ERP receipt in the period), plus anyone
    // else whose receipts are filed under the unit.
    const zimmedaran = await User.find({
      role: 'zimmedar',
      isActive: true,
      unitPath: { $regex: `^${escapeRegex(unit.path)}(/|$)` },
    })
      .select('_id ajeerCode name nameUr unitCode')
      .lean();
    const ids = new Set(zimmedaran.map((u) => String(u._id)));
    const others = await User.find({
      _id: { $in: perUser.map((r) => r._id.u).filter((id) => !ids.has(String(id))) },
    })
      .select('_id ajeerCode name nameUr unitCode')
      .lean();
    const sums = new Map<string, Sums>();
    for (const r of perUser) {
      const key = String(r._id.u);
      const s = sums.get(key) ?? emptySums();
      s.entries += r.entries;
      s.receipts += r.receipts.length;
      s.naqd += r.naqd;
      s.jins += r.jins;
      sums.set(key, s);
    }
    const rows = [...zimmedaran, ...others]
      .map((u) => ({
        id: String(u._id),
        ajeerCode: u.ajeerCode,
        name: u.name,
        nameUr: u.nameUr ?? null,
        unitCode: u.unitCode,
        ...(sums.get(String(u._id)) ?? emptySums()),
      }))
      .sort((a, b) => b.naqd + b.jins - (a.naqd + a.jins) || a.name.localeCompare(b.name));
    return { ...base, rowsKind: 'zimmedaran' as const, rows };
  }

  const children = await Unit.find({ parentCode: unit.code, isActive: true })
    .select('code name nameUr level path')
    .sort({ name: 1 })
    .lean();
  const rows = children.map((c) => {
    const s = emptySums();
    const set = new Set<string>();
    for (const r of perUser) {
      if (r._id.p !== c.path && !r._id.p.startsWith(`${c.path}/`)) continue;
      s.entries += r.entries;
      s.naqd += r.naqd;
      s.jins += r.jins;
      for (const no of r.receipts) set.add(String(no));
    }
    s.receipts = set.size;
    return {
      unit: { code: c.code, name: c.name, nameUr: c.nameUr ?? null, level: c.level },
      ...s,
    };
  });
  return {
    ...base,
    rowsKind: 'children' as const,
    childLevel: LEVEL_ORDER[LEVEL_ORDER.indexOf(unit.level) + 1] ?? 'district',
    rows,
  };
}

/** Receipt lines listed on a zimmedar's own screen (newest first). */
const MAX_OWN_LINES = 300;

/** GET /me/erp — the zimmedar's own ERP receipts in a period: totals, by mad, by Gaon, lines. */
export async function myErp(
  user: AuthUser,
  q: { period: SummaryPeriod; date?: string | undefined; from?: string | undefined },
) {
  await connectDb();
  const span = await range(q.period, q.date, q.from);
  const match = {
    userId: new Types.ObjectId(user.id),
    date: { $gte: span.from, $lte: span.to },
    cancelled: false,
  };
  const [lines, mads, last] = await Promise.all([
    ErpReceipt.find(match)
      .select('receiptNo lineNo date villageName kind amount mad item qty qtyUnit')
      .sort({ date: -1, receiptNo: 1, lineNo: 1 })
      .lean(),
    byMad(match),
    lastUpload(),
  ]);
  const totals = emptySums();
  totals.entries = lines.length;
  totals.receipts = new Set(lines.map((l) => l.receiptNo)).size;
  const gaon = new Map<string, { gaon: string | null; naqd: number; jins: number }>();
  for (const l of lines) {
    if (l.kind === 'naqd') totals.naqd += l.amount;
    else totals.jins += l.amount;
    const key = l.villageName ?? '';
    const g = gaon.get(key) ?? { gaon: l.villageName ?? null, naqd: 0, jins: 0 };
    if (l.kind === 'naqd') g.naqd += l.amount;
    else g.jins += l.amount;
    gaon.set(key, g);
  }
  return {
    ...span,
    totals,
    byMad: mads,
    byGaon: [...gaon.values()].sort((a, b) => b.naqd + b.jins - (a.naqd + a.jins)),
    lines: lines.slice(0, MAX_OWN_LINES).map(({ _id, ...l }) => ({
      ...l,
      villageName: l.villageName ?? null,
      mad: l.mad ?? null,
      item: l.item ?? null,
      qty: l.qty ?? null,
      qtyUnit: l.qtyUnit ?? null,
    })),
    moreLines: Math.max(0, lines.length - MAX_OWN_LINES),
    lastUpload: last,
  };
}

/** The format sample for the ERP / Finance team (invented values). */
export const ERP_TEMPLATE_CSV = [
  'receipt_no,line_no,receipt_date,ajeer_code,gaon_name,attiyat_type,amount_rs,mad,jins_item,jins_qty,jins_unit,status,suba,division,district,tehsil',
  'ER-2026-000101,1,2026-11-11,1234567,Basti Misali,NAQAD,20000,Telethon,,,,ACTIVE,Sindh,Sukkur,Ghotki,Mirpur Mathelo',
  'ER-2026-000101,2,2026-11-11,1234567,Basti Misali,NAQAD,25000,Ramzan Atiyat,,,,ACTIVE,Sindh,Sukkur,Ghotki,Mirpur Mathelo',
  'ER-2026-000102,1,2026-11-11,1234567,Basti Misali,JINS,5000,Ushr,Chawal,40,KG,ACTIVE,Sindh,Sukkur,Ghotki,Mirpur Mathelo',
  'ER-2026-000099,1,2026-11-10,1234567,Goth Namoona,NAQAD,1500,Mahana Atiyat,,,,CANCELLED,Sindh,Sukkur,Ghotki,Mirpur Mathelo',
].join('\r\n');

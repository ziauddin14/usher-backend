// E-Raseed (ERP) receipts (CTO 11 Nov 2026): the Pakistan level uploads the ERP's daily file;
// every level then sees what each zimmedar's receipts brought in, by mad. The ERP is the source of
// truth for these details — nothing here is typed by a zimmedar. No Gaon: Finance does not allow a
// Gaon field in the ERP, so there is no Gaon breakdown (CTO 12 Nov 2026).
import { Types } from 'mongoose';
import type { AuthUser } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { connectDb } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { assertInScope, escapeRegex } from '../../lib/scope.js';
import { getRewardRules, getSettings } from '../../lib/settings.js';
import { karachiDate } from '../../lib/time.js';
import { ErpReceipt, ErpUpload } from '../../models/erp-receipt.js';
import { Jadwal } from '../../models/jadwal.js';
import { Unit, type UnitLevel } from '../../models/unit.js';
import { User } from '../../models/user.js';
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
}

type Change = 'added' | 'updated' | 'unchanged';

const COMPARED = [
  'date',
  'ajeerCode',
  'kind',
  'amount',
  'mad',
  'donorName',
  'item',
  'qty',
  'qtyUnit',
  'cancelled',
  'fund',
  'deposited',
] as const;

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

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

  const existing = await ErpReceipt.find({
    receiptNo: { $in: [...new Set(lines.map((l) => l.receiptNo))] },
  })
    .select('receiptNo lineNo userId unitPath ' + COMPARED.join(' '))
    .lean();
  const existingBy = new Map(existing.map((e) => [`${e.receiptNo}\u0000${e.lineNo}`, e]));
  const changes = lines.map((l): { line: Resolved; change: Change; keepPath?: string } => {
    const old = existingBy.get(`${l.receiptNo}\u0000${l.lineNo}`);
    if (!old) return { line: l, change: 'added' };
    const differs = COMPARED.some((k) => !same(old[k], l[k])) || !old.userId.equals(l.userId);
    // A line keeps the unit it was first saved under while it stays with the same zimmedar.
    const keepPath = old.userId.equals(l.userId) ? old.unitPath : undefined;
    return {
      line: l,
      change: differs ? 'updated' : 'unchanged',
      ...(keepPath ? { keepPath } : {}),
    };
  });

  // A saved line above the receipt's last line in this file no longer exists in the ERP (the
  // receipt was edited): it is cancelled, never deleted.
  const removed = existing.filter(
    (e) =>
      !e.cancelled &&
      checked.receiptLines.has(e.receiptNo) &&
      e.lineNo > checked.receiptLines.get(e.receiptNo)!,
  );

  const active = lines.filter((l) => !l.cancelled);
  const dates = lines.map((l) => l.date).sort();
  const count = (c: Change) =>
    changes.filter((x) => x.change === c).length + (c === 'updated' ? removed.length : 0);
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
      for (const k of [
        'mad',
        'donorName',
        'item',
        'qty',
        'qtyUnit',
        'fund',
        'deposited',
      ] as const) {
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
  for (const e of removed) {
    writes.push({
      updateOne: {
        filter: { receiptNo: e.receiptNo, lineNo: e.lineNo },
        update: { $set: { cancelled: true, uploadId: upload._id } },
        upsert: false,
      },
    });
  }
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
  const u = await ErpUpload.findOne().sort({ at: -1, _id: -1 }).select('at dateFrom dateTo').lean();
  return u ? { at: u.at, dateFrom: u.dateFrom ?? null, dateTo: u.dateTo ?? null } : null;
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
  const [perUser, mads, last, written] = await Promise.all([
    ErpReceipt.aggregate<{
      _id: { u: Types.ObjectId; p: string };
      entries: number;
      receipts: unknown[];
      naqd: number;
      jins: number;
    }>([{ $match: match }, { $group: { _id: { u: '$userId', p: '$unitPath' }, ...sumStages } }]),
    byMad(match),
    lastUpload(),
    writtenWusooli({ unitPath: match.unitPath }, span),
  ]);
  const writtenBy = new Map<string, number>();
  for (const w of written) {
    writtenBy.set(String(w._id.u), (writtenBy.get(String(w._id.u)) ?? 0) + w.wusooli);
  }
  const writtenTotal = written.reduce((s, w) => s + w.wusooli, 0);

  const totals = emptySums();
  const receiptSet = new Set<string>();
  for (const r of perUser) {
    totals.entries += r.entries;
    totals.naqd += r.naqd;
    totals.jins += r.jins;
    for (const no of r.receipts) receiptSet.add(String(no));
  }
  totals.receipts = receiptSet.size;

  const base = {
    unit,
    ...span,
    totals: { ...totals, written: writtenTotal },
    byMad: mads,
    lastUpload: last,
  };
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
        written: writtenBy.get(String(u._id)) ?? 0,
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
    const inChild = (p: string) => p === c.path || p.startsWith(`${c.path}/`);
    return {
      unit: { code: c.code, name: c.name, nameUr: c.nameUr ?? null, level: c.level },
      ...s,
      written: written.filter((w) => inChild(w._id.p)).reduce((t, w) => t + w.wusooli, 0),
    };
  });
  return {
    ...base,
    rowsKind: 'children' as const,
    childLevel: LEVEL_ORDER[LEVEL_ORDER.indexOf(unit.level) + 1] ?? 'district',
    rows,
  };
}

/**
 * What the zimmedaran wrote in UsherDesk (submitted jadwals' wusooli) in the period, per user and
 * unit — set next to the ERP receipts (CTO 13 Nov 2026: one total in UsherDesk, the details from
 * the ERP).
 */
async function writtenWusooli(
  filter: { userId: Types.ObjectId } | { unitPath: { $regex: string } },
  span: { from: string; to: string },
) {
  return Jadwal.aggregate<{ _id: { u: Types.ObjectId; p: string }; wusooli: number }>([
    { $match: { ...filter, status: 'submitted', date: { $gte: span.from, $lte: span.to } } },
    {
      $group: {
        _id: { u: '$userId', p: '$unitPath' },
        wusooli: { $sum: { $ifNull: ['$totals.wusooli', 0] } },
      },
    },
  ]);
}

/** Receipt lines listed on a zimmedar's own screen (newest first). */
const MAX_OWN_LINES = 300;

type Query = { period: SummaryPeriod; date?: string | undefined; from?: string | undefined };

/**
 * One zimmedar's ERP receipts in a period (CTO 13 Nov 2026): what he wrote in UsherDesk next to
 * what the ERP shows reached the account — by mad, by donor, and line by line.
 */
async function erpOfUser(userId: Types.ObjectId, q: Query) {
  const span = await range(q.period, q.date, q.from);
  const match = { userId, date: { $gte: span.from, $lte: span.to }, cancelled: false };
  const [lines, mads, last, written] = await Promise.all([
    ErpReceipt.find(match)
      .select('receiptNo lineNo date kind amount mad donorName item qty qtyUnit')
      .sort({ date: -1, receiptNo: 1, lineNo: 1 })
      .lean(),
    byMad(match),
    lastUpload(),
    writtenWusooli({ userId }, span),
  ]);
  const totals = { ...emptySums(), written: written.reduce((s, w) => s + w.wusooli, 0) };
  totals.entries = lines.length;
  totals.receipts = new Set(lines.map((l) => l.receiptNo)).size;
  const donors = new Map<
    string,
    { donor: string | null; naqd: number; jins: number; receipts: Set<string> }
  >();
  for (const l of lines) {
    if (l.kind === 'naqd') totals.naqd += l.amount;
    else totals.jins += l.amount;
    const key = l.donorName ?? '';
    const d = donors.get(key) ?? {
      donor: l.donorName ?? null,
      naqd: 0,
      jins: 0,
      receipts: new Set(),
    };
    if (l.kind === 'naqd') d.naqd += l.amount;
    else d.jins += l.amount;
    d.receipts.add(l.receiptNo);
    donors.set(key, d);
  }
  return {
    ...span,
    totals,
    byMad: mads,
    byDonor: [...donors.values()]
      .map(({ receipts, ...d }) => ({ ...d, receipts: receipts.size }))
      .sort((a, b) => b.naqd + b.jins - (a.naqd + a.jins)),
    lines: lines.slice(0, MAX_OWN_LINES).map(({ _id, ...l }) => ({
      ...l,
      mad: l.mad ?? null,
      donorName: l.donorName ?? null,
      item: l.item ?? null,
      qty: l.qty ?? null,
      qtyUnit: l.qtyUnit ?? null,
    })),
    moreLines: Math.max(0, lines.length - MAX_OWN_LINES),
    lastUpload: last,
  };
}

/** GET /me/erp — the zimmedar's own ERP receipts in a period. */
export async function myErp(user: AuthUser, q: Query) {
  await connectDb();
  return erpOfUser(new Types.ObjectId(user.id), q);
}

/** GET /dash/zimmedaran/:userId/erp — a zimmedar in the caller's scope (404 otherwise). */
export async function userErp(caller: AuthUser, userId: string, q: Query) {
  await connectDb();
  const user = await User.findById(userId).select('_id ajeerCode name nameUr unitPath').lean();
  assertInScope(caller, user ? { unitPath: user.unitPath } : null);
  return {
    user: {
      id: String(user!._id),
      ajeerCode: user!.ajeerCode,
      name: user!.name,
      nameUr: user!.nameUr ?? null,
    },
    ...(await erpOfUser(user!._id, q)),
  };
}

/** The format sample for the ERP / Finance team (invented values). */
export const ERP_TEMPLATE_CSV = [
  'receipt_no,line_no,receipt_date,ajeer_code,donor_name,attiyat_type,amount_rs,mad,jins_item,jins_qty,jins_unit,status,suba,division,district,tehsil',
  'ER-2026-000101,1,2026-11-11,1234567,Donor Misal,NAQAD,20000,Telethon,,,,ACTIVE,Sindh,Sukkur,Ghotki,Mirpur Mathelo',
  'ER-2026-000101,2,2026-11-11,1234567,Donor Misal,NAQAD,25000,Ramzan Atiyat,,,,ACTIVE,Sindh,Sukkur,Ghotki,Mirpur Mathelo',
  'ER-2026-000102,1,2026-11-11,1234567,Donor Namoona,JINS,5000,Ushr,Chawal,40,KG,ACTIVE,Sindh,Sukkur,Ghotki,Mirpur Mathelo',
  'ER-2026-000099,1,2026-11-10,1234567,Donor Namoona,NAQAD,1500,Mahana Atiyat,,,,CANCELLED,Sindh,Sukkur,Ghotki,Mirpur Mathelo',
].join('\r\n');

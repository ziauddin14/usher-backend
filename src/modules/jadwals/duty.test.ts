import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import type { AuthUser } from '../../lib/auth.js';
import { AuditLog } from '../../models/audit-log.js';
import { Jadwal } from '../../models/jadwal.js';
import { User } from '../../models/user.js';
import { seedHistory } from '../../seed/history.js';
import { seedDemo } from '../../seed/seed.js';
import { percent } from '../dash/service.js';
import { setPermission } from '../users/permissions.js';
import { assertDutyApprover } from './duty.js';

// Official-duty approval of a full-day mashwara (CTO 6 Nov 2026). Invented demo data only.
const app = createApp();
const TODAY = '2026-11-02';
const cookies: Record<string, string> = {};
const get = (url: string, who: string) =>
  request(app).get(`/api/v1${url}`).set('Cookie', cookies[who]!);
const post = (url: string, who: string, body: object = {}) =>
  request(app).post(`/api/v1${url}`).set('Cookie', cookies[who]!).send(body);
/**
 * Decide as a screen would: `expected` = the decision it shows (default: the one stored now).
 * `decide(...).expect(status)` resolves to the response, like a supertest request.
 */
const decide = (
  id: string,
  who: string,
  decision: string,
  reason?: string,
  expected?: string | null,
) => ({
  expect: async (status: number) => {
    const seen =
      expected !== undefined
        ? expected
        : Types.ObjectId.isValid(id)
          ? ((await Jadwal.findById(id).select('dutyApproval').lean())?.dutyApproval?.status ??
            null)
          : null;
    return post(`/jadwals/${id}/duty-approval`, who, {
      decision,
      expected: seen,
      ...(reason ? { reason } : {}),
    }).expect(status);
  },
});

interface Tiles {
  zimmedaran: number;
  today: { submitted: number; field: number; submittedPct: number; fieldPct: number };
}
const ghotkiTiles = async () =>
  ((await get('/dash/units/GHOTKI/overview', '9040001').expect(200)).body as { tiles: Tiles })
    .tiles;
const todayOf = async (ajeerCode: string) => {
  const rows = (await get('/dash/units/GHOTKI/zimmedaran', '9040001').expect(200)).body.rows as {
    ajeerCode: string;
    today: string;
  }[];
  return rows.find((r) => r.ajeerCode === ajeerCode)!.today;
};
const xlsx = async (url: string) => {
  const res = await get(url, '9030001')
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    })
    .expect(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body as ArrayBuffer);
  const ws = wb.worksheets[0]!;
  const header: string[] = [];
  ws.getRow(2).eachCell((cell, i) => {
    header[i] = cell.text;
  });
  const texts = (r: ExcelJS.Row) => {
    const out: string[] = [];
    r.eachCell((cell) => out.push(cell.text));
    return out;
  };
  return { ws, texts, col: (name: string) => header.indexOf(name) };
};

let mashwaraId = '';
/** The days Excel's "Sarkari duty" cell for 9090412 today. */
const dutyCell = async () => {
  const owner = await User.findOne({ ajeerCode: '9090412' }).lean();
  const d = await xlsx(`/dash/export.xlsx?view=days&userId=${String(owner!._id)}&month=2026-11`);
  const row = Array.from({ length: d.ws.rowCount }, (_, i) => d.ws.getRow(i + 1)).find(
    (r) => r.getCell(1).text === TODAY,
  )!;
  return row.getCell(d.col('Sarkari duty')).text;
};

describe('official-duty approval of a full-day mashwara', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${TODAY}T07:00:00Z`) });
    await seedDemo({ reset: true });
    const ghotki = await User.find({ role: 'zimmedar', unitCode: 'GHOTKI' }).lean();
    await seedHistory(TODAY, { ajeerCodes: ghotki.map((u) => u.ajeerCode) });
    await User.create({
      ajeerCode: '40003',
      name: 'Test Larkana District',
      role: 'district',
      unitCode: 'LARKANA_DIST',
      unitPath: 'PK/INT_SINDH/LARKANA/LARKANA_DIST',
      passwordHash: await bcrypt.hash('demo1234', 4),
      mustChangePassword: false,
    });
    for (const code of ['9040001', '9030001', '9020001', '9010001', '9090412', '40003']) {
      cookies[code] = await loginCookie(app, code);
    }
    // A second Ghotki zimmedar (same level as the owner).
    const other = ghotki.find((u) => u.ajeerCode !== '9090412')!;
    cookies.peer = await loginCookie(app, other.ajeerCode);
    cookies.peerCode = other.ajeerCode;
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('history is never approved automatically', async () => {
    expect(await Jadwal.countDocuments({ entryType: 'mashwara_full' })).toBeGreaterThan(10);
    expect(await Jadwal.countDocuments({ dutyApproval: { $exists: true } })).toBe(0);
  });

  it('an undecided full-day mashwara counts in Jadwal Submission % only', async () => {
    const before = await ghotkiTiles();
    expect(before.today).toMatchObject({ submitted: 0, field: 0 });
    const res = await post('/jadwals', '9090412', { entryType: 'mashwara_full' }).expect(201);
    mashwaraId = res.body.jadwal.id as string;
    expect(res.body.jadwal).toMatchObject({ status: 'submitted', dutyApproval: null });
    expect(await todayOf('9090412')).toBe('mashwara_full');
    const t = await ghotkiTiles();
    expect(t.today).toMatchObject({
      submitted: 1,
      field: 0,
      submittedPct: percent(1, t.zimmedaran),
      fieldPct: 0,
    });
    expect(await dutyCell()).toBe('Duty faisla baqi');
  });

  it('only the level directly above decides — never the owner, a peer, a higher level or another district', async () => {
    // The mobile-verification permission grants nothing here.
    await setPermission({
      ajeerCode: '9010001',
      permission: 'VERIFY_SUBA_MOBILE',
      grant: true,
      actor: 'test',
    });
    await decide(mashwaraId, '9090412', 'approve').expect(403); // the owner (self)
    await decide(mashwaraId, 'peer', 'approve').expect(403); // same level
    await decide(mashwaraId, '9030001', 'approve').expect(403); // two levels up
    await decide(mashwaraId, '9020001', 'approve').expect(403);
    await decide(mashwaraId, '9010001', 'approve').expect(403);
    await decide(mashwaraId, '40003', 'approve').expect(404); // other district: out of scope
    await decide(mashwaraId, '9040001', 'maybe').expect(400);
    expect(
      await AuditLog.countDocuments({
        action: { $in: ['MASHWARA_DUTY_APPROVE', 'MASHWARA_DUTY_REJECT'] },
      }),
    ).toBe(0);
    expect(await todayOf('9090412')).toBe('mashwara_full');
  });

  it('a rejected mashwara stays Submission only (audited)', async () => {
    const res = await decide(mashwaraId, '9040001', 'reject', 'Duty ka hukm nahi tha').expect(200);
    expect(res.body.dutyApproval).toMatchObject({ status: 'rejected', byAjeerCode: '9040001' });
    expect(await todayOf('9090412')).toBe('mashwara_full');
    expect((await ghotkiTiles()).today).toMatchObject({ submitted: 1, field: 0 });
    expect(await dutyCell()).toBe('Duty mustarad');
    const log = await AuditLog.findOne({ action: 'MASHWARA_DUTY_REJECT' }).lean();
    expect(log).toMatchObject({
      actorAjeerCode: '9040001',
      targetType: 'jadwal',
      targetId: mashwaraId,
      details: { date: TODAY, ajeerCode: '9090412', previous: null },
    });
    expect(log!.at).toBeInstanceOf(Date);
  });

  it('changing a decision needs a reason; repeating it changes nothing; history is kept in full', async () => {
    // Rejected → approve without a reason (or a too short one): refused, nothing changes.
    for (const reason of [undefined, 'abc']) {
      const r = await decide(mashwaraId, '9040001', 'approve', reason).expect(400);
      expect(r.body.error.details).toMatchObject({ field: 'reason', reason: 'REASON_REQUIRED' });
    }
    expect(await todayOf('9090412')).toBe('mashwara_full');
    expect(await dutyCell()).toBe('Duty mustarad');
    // Repeating the current decision: 200, no write, no second audit entry.
    await decide(mashwaraId, '9040001', 'reject').expect(200);
    expect(await AuditLog.countDocuments({ action: 'MASHWARA_DUTY_REJECT' })).toBe(1);
  });

  it('an approved mashwara counts in both; dashboard, children, Excel and print data agree', async () => {
    await decide(mashwaraId, '9040001', 'approve', 'Sarkari hukm mil gaya').expect(200);
    const j = (await get(`/jadwals/${mashwaraId}`, '9040001').expect(200)).body.jadwal;
    expect(j.dutyApproval).toMatchObject({
      status: 'approved',
      byAjeerCode: '9040001',
      reason: 'Sarkari hukm mil gaya',
    });
    const approveLog = await AuditLog.findOne({ action: 'MASHWARA_DUTY_APPROVE' }).lean();
    expect(approveLog).toMatchObject({
      actorAjeerCode: '9040001',
      details: {
        previous: 'rejected',
        previousDecision: {
          status: 'rejected',
          byAjeerCode: '9040001',
          reason: 'Duty ka hukm nahi tha',
        },
        reason: 'Sarkari hukm mil gaya',
      },
    });
    expect(await todayOf('9090412')).toBe('mashwara_duty');

    const t = await ghotkiTiles();
    expect(t.today).toMatchObject({
      submitted: 1,
      field: 1,
      submittedPct: percent(1, t.zimmedaran),
      fieldPct: percent(1, t.zimmedaran),
    });
    // Children (B2) row = the district's own tiles.
    const kids = (await get('/dash/units/SUKKUR/children', '9030001').expect(200)).body
      .rows as (Tiles & {
      unit: { code: string; name: string };
    })[];
    const g = kids.find((r) => r.unit.code === 'GHOTKI')!;
    expect(g.today).toMatchObject(t.today);

    // Excel children: the same per-row percentages, and the totals row recomputed from sums.
    const c = await xlsx('/dash/export.xlsx?view=children&code=SUKKUR&period=day');
    const jamaCol = c.col('Jadwal jama % (aaj)');
    const fieldCol = c.col('Field activity % (aaj)');
    expect(jamaCol).toBeGreaterThan(0);
    expect(fieldCol).toBeGreaterThan(0);
    const gRow = Array.from({ length: c.ws.rowCount }, (_, i) => c.ws.getRow(i + 1)).find(
      (r) => r.getCell(1).text === g.unit.name,
    )!;
    expect(Number(gRow.getCell(fieldCol).value)).toBe(g.today.fieldPct);
    expect(Number(gRow.getCell(jamaCol).value)).toBe(g.today.submittedPct);
    const sum = (f: (r: Tiles) => number) => kids.reduce((s, r) => s + f(r), 0);
    const total = c.ws.getRow(c.ws.rowCount);
    expect(Number(total.getCell(fieldCol).value)).toBe(
      percent(
        sum((r) => r.today.field),
        sum((r) => r.zimmedaran),
      ),
    );
    // Excel zimmedaran + days: the same classification text.
    const z = await xlsx('/dash/export.xlsx?view=zimmedaran&code=GHOTKI&period=day');
    const aaj = z.col('Aaj');
    const zRow = Array.from({ length: z.ws.rowCount }, (_, i) => z.ws.getRow(i + 1)).find((r) =>
      z.texts(r).some((t) => t.includes('9090412')),
    )!;
    expect(zRow.getCell(aaj).text).toBe('Mashwara (sarkari duty)');
    const owner = await User.findOne({ ajeerCode: '9090412' }).lean();
    const days = (
      await get(`/dash/zimmedaran/${String(owner!._id)}/days?month=2026-11`, '9040001').expect(200)
    ).body.days as { id: string; dutyApproval: string | null }[];
    expect(days.find((d) => d.id === mashwaraId)!.dutyApproval).toBe('approved');
    const d = await xlsx(`/dash/export.xlsx?view=days&userId=${String(owner!._id)}&month=2026-11`);
    const dRow = Array.from({ length: d.ws.rowCount }, (_, i) => d.ws.getRow(i + 1)).find(
      (r) => r.getCell(1).text === TODAY,
    )!;
    expect(dRow.getCell(d.col('Sarkari duty')).text).toBe('Duty manzoor');
  });

  it('reopen clears the decision; a draft mashwara counts in neither; re-submitted = undecided', async () => {
    await post(`/jadwals/${mashwaraId}/reopen`, '9040001', {
      reason: 'Tafseel durust karein',
    }).expect(200);
    expect(await todayOf('9090412')).toBe('jari');
    expect((await ghotkiTiles()).today).toMatchObject({ submitted: 0, field: 0 });
    expect((await Jadwal.findById(mashwaraId).lean())!.dutyApproval).toBeUndefined();
    expect(
      await AuditLog.findOne({ action: 'JADWAL_REOPEN', targetId: mashwaraId }).lean(),
    ).toMatchObject({
      details: {
        clearedDutyApproval: 'approved',
        clearedDutyDecision: {
          status: 'approved',
          byAjeerCode: '9040001',
          reason: 'Sarkari hukm mil gaya',
        },
      },
    });
    // Every earlier decision is still in the audit history.
    expect(
      (
        await AuditLog.find({
          targetId: mashwaraId,
          action: { $in: ['MASHWARA_DUTY_APPROVE', 'MASHWARA_DUTY_REJECT'] },
        })
          .sort({ _id: 1 })
          .lean()
      ).map((l) => l.action),
    ).toEqual(['MASHWARA_DUTY_REJECT', 'MASHWARA_DUTY_APPROVE']);
    const draft = await decide(mashwaraId, '9040001', 'approve').expect(409);
    expect(draft.body.error.details).toMatchObject({ reason: 'NOT_SUBMITTED' });
    // Excel agrees with the screen and print: a draft has no duty state.
    const owner = await User.findOne({ ajeerCode: '9090412' }).lean();
    const d = await xlsx(`/dash/export.xlsx?view=days&userId=${String(owner!._id)}&month=2026-11`);
    const dRow = Array.from({ length: d.ws.rowCount }, (_, i) => d.ws.getRow(i + 1)).find(
      (r) => r.getCell(1).text === TODAY,
    )!;
    expect(dRow.getCell(d.col('Sarkari duty')).text).toBe('');

    // Even a decision left on the draft (e.g. by a write racing the reopen) never survives a
    // re-submission: the mashwara is undecided again.
    await Jadwal.updateOne(
      { _id: mashwaraId },
      {
        $set: {
          dutyApproval: {
            status: 'approved',
            by: owner!._id,
            byAjeerCode: '9040001',
            at: new Date(),
          },
        },
      },
    );
    const resubmitted = await post(`/jadwals/${mashwaraId}/submit`, '9090412', {}).expect(200);
    expect(resubmitted.body.jadwal.dutyApproval).toBeNull();
    expect((await Jadwal.findById(mashwaraId).lean())!.dutyApproval).toBeUndefined();
    expect(await todayOf('9090412')).toBe('mashwara_full');
    expect((await ghotkiTiles()).today).toMatchObject({ submitted: 1, field: 0 });
  });

  it('a decision never lands on a later submission; a double submit is refused', async () => {
    // The jadwal is re-submitted between the decision's read and its write (simulated): 409.
    const original = Jadwal.updateOne.bind(Jadwal);
    const spy = vi
      .spyOn(Jadwal, 'updateOne')
      .mockImplementationOnce(((filter: Record<string, unknown>, update: Record<string, unknown>) =>
        Jadwal.collection
          .updateOne(
            { _id: new Types.ObjectId(mashwaraId) },
            { $set: { submittedAt: new Date(Date.parse(`${TODAY}T08:00:00Z`)) } },
          )
          .then(() => original(filter, update))) as unknown as typeof Jadwal.updateOne);
    const stale = await decide(mashwaraId, '9040001', 'approve').expect(409);
    expect(stale.body.error.message).toMatch(/changed meanwhile/);
    spy.mockRestore();
    expect((await Jadwal.findById(mashwaraId).lean())!.dutyApproval).toBeUndefined();
    expect(await todayOf('9090412')).toBe('mashwara_full');

    // Another decision lands between this request's read and its write (simulated): 409 — a
    // change never slips past the reason rule by overwriting a decision it did not see.
    const owner = await User.findOne({ ajeerCode: '9090412' }).lean();
    const spy2 = vi.spyOn(Jadwal, 'updateOne').mockImplementationOnce(((
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ) =>
      Jadwal.collection
        .updateOne(
          { _id: new Types.ObjectId(mashwaraId) },
          {
            $set: {
              dutyApproval: {
                status: 'rejected',
                by: owner!._id,
                byAjeerCode: '9040001',
                at: new Date(),
              },
            },
          },
        )
        .then(() => original(filter, update))) as unknown as typeof Jadwal.updateOne);
    const raced = await decide(mashwaraId, '9040001', 'approve').expect(409);
    expect(raced.body.error.message).toMatch(/changed meanwhile/);
    spy2.mockRestore();
    expect((await Jadwal.findById(mashwaraId).lean())!.dutyApproval).toMatchObject({
      status: 'rejected',
    });
    // A screen that still shows "undecided" while the jadwal is already rejected: 409, nothing
    // written (no silent 200, no reason rule skipped).
    const stale2 = await decide(mashwaraId, '9040001', 'reject', undefined, null).expect(409);
    expect(stale2.body.error.details).toMatchObject({
      reason: 'DECISION_CHANGED',
      current: 'rejected',
    });
    // An existing decision replaced between read and write (same status, newer time): 409.
    const t1 = (await Jadwal.findById(mashwaraId).lean())!.dutyApproval!;
    const spy3 = vi
      .spyOn(Jadwal, 'updateOne')
      .mockImplementationOnce(((filter: Record<string, unknown>, update: Record<string, unknown>) =>
        Jadwal.collection
          .updateOne(
            { _id: new Types.ObjectId(mashwaraId) },
            { $set: { 'dutyApproval.at': new Date(t1.at.getTime() + 60_000) } },
          )
          .then(() => original(filter, update))) as unknown as typeof Jadwal.updateOne);
    const raced2 = await decide(mashwaraId, '9040001', 'approve', 'Hukm ab mila').expect(409);
    expect(raced2.body.error.message).toMatch(/changed meanwhile/);
    spy3.mockRestore();
    const kept = (await Jadwal.findById(mashwaraId).lean())!.dutyApproval!;
    expect(kept.status).toBe('rejected');
    expect(kept.at.getTime()).toBe(t1.at.getTime() + 60_000);
    await Jadwal.updateOne({ _id: mashwaraId }, { $unset: { dutyApproval: 1 } }); // fixture only

    // Two submits of the same draft: the second never overwrites the first.
    await post(`/jadwals/${mashwaraId}/reopen`, '9040001', { reason: 'Dobara dekhein' }).expect(
      200,
    );
    const [a, b] = await Promise.all([
      post(`/jadwals/${mashwaraId}/submit`, '9090412', {}),
      post(`/jadwals/${mashwaraId}/submit`, '9090412', {}),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await todayOf('9090412')).toBe('mashwara_full');
  });

  it('only a submitted full-day mashwara is decided', async () => {
    const res = await post('/jadwals', 'peer', { entryType: 'rukhsat' }).expect(201);
    const r = await decide(res.body.jadwal.id as string, '9040001', 'approve').expect(409);
    expect(r.body.error.details).toMatchObject({ reason: 'NOT_MASHWARA' });
    expect(await todayOf(cookies.peerCode!)).toBe('rukhsat');
  });
});

describe('assertDutyApprover', () => {
  const caller = (id: string, role: AuthUser['role']): AuthUser => ({
    id,
    ajeerCode: '1',
    name: 'x',
    role,
    unitCode: 'X',
    unitPath: 'PK',
    mustChangePassword: false,
    permissions: ['VERIFY_SUBA_MOBILE', 'VERIFY_PAKISTAN_MOBILE'],
    department: 'CENTRAL_IT',
  });
  const owner = (id: string, role: AuthUser['role']) => ({ _id: id, role });

  it('the level directly above only; never self, same level, two levels up, or for suba / pakistan owners', () => {
    expect(() => assertDutyApprover(caller('a', 'district'), owner('b', 'zimmedar'))).not.toThrow();
    expect(() => assertDutyApprover(caller('a', 'division'), owner('b', 'district'))).not.toThrow();
    expect(() => assertDutyApprover(caller('a', 'suba'), owner('b', 'division'))).not.toThrow();
    expect(() => assertDutyApprover(caller('a', 'district'), owner('a', 'zimmedar'))).toThrow(
      /own mashwara/,
    );
    expect(() => assertDutyApprover(caller('a', 'district'), owner('b', 'district'))).toThrow(
      /directly above/,
    );
    expect(() => assertDutyApprover(caller('a', 'division'), owner('b', 'zimmedar'))).toThrow(
      /directly above/,
    );
    // Designated permissions / department do not make anyone an approver.
    expect(() => assertDutyApprover(caller('a', 'pakistan'), owner('b', 'suba'))).toThrow(
      /No official-duty approver/,
    );
    expect(() => assertDutyApprover(caller('a', 'pakistan'), owner('b', 'pakistan'))).toThrow(
      /No official-duty approver/,
    );
  });
});

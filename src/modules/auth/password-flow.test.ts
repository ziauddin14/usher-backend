import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { AuditLog } from '../../models/audit-log.js';
import { PasswordResetRequest } from '../../models/password-reset-request.js';
import { User } from '../../models/user.js';
import { seedDemo } from '../../seed/seed.js';
import { provisionPakistanAdmin, setPakistanAdminActive } from '../users/provision.js';
import { INITIAL_PASSWORD } from './schemas.js';

const app = createApp();

/** Put a seeded user into the "imported, never logged in" state: initial password + forced change. */
async function makeNewUser(ajeerCode: string, mobile?: string): Promise<void> {
  const passwordHash = await bcrypt.hash(INITIAL_PASSWORD, 4);
  await User.updateOne(
    { ajeerCode },
    mobile
      ? { $set: { passwordHash, mustChangePassword: true, mobile } }
      : { $set: { passwordHash, mustChangePassword: true }, $unset: { mobile: '' } },
  );
}

function login(body: Record<string, string>) {
  return request(app).post('/api/v1/auth/login').send(body);
}

const cookieOf = (res: { headers: Record<string, unknown> }) =>
  (res.headers['set-cookie'] as string[])[0]!.split(';')[0]!;

describe('first login: Ajeer Code + initial password only — no mobile (CTO 7 Nov 2026)', () => {
  let ghotki = '';
  beforeAll(async () => {
    await seedDemo({ reset: true });
    await makeNewUser('9000001'); // no mobile on record
    // A Ghotki zimmedar with a mobile on record (the demo district 9040001 lists it).
    ghotki = (await User.findOne({
      unitCode: 'GHOTKI',
      role: 'zimmedar',
      ajeerCode: { $ne: '9090412' },
    }).lean())!.ajeerCode;
    await makeNewUser(ghotki, '03001112233');
  });

  it('logs in without any mobile, with or without a number on record', async () => {
    for (const ajeerCode of ['9000001', ghotki]) {
      const res = await login({ ajeerCode, password: INITIAL_PASSWORD }).expect(200);
      expect(res.body.user.mustChangePassword).toBe(true);
      expect(res.headers['set-cookie']).toBeDefined();
    }
    // A stray "mobile" field is ignored — never checked, never saved.
    await login({ ajeerCode: '9000001', password: INITIAL_PASSWORD, mobile: '03119999999' }).expect(
      200,
    );
    expect((await User.findOne({ ajeerCode: '9000001' }).lean())!.mobile).toBeUndefined();
    // No mobile-verification audit entry is ever written.
    const actions = await AuditLog.distinct('action');
    expect(actions.filter((a) => /^MOBILE_(SELF|CONFIRM|REJECT|VIEW|CHANGE)/.test(a))).toEqual([]);
  });

  it('wrong password → 401 INVALID_CREDENTIALS; unknown code → the same answer', async () => {
    const bad = await login({ ajeerCode: '9000001', password: 'nope' }).expect(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    const unknown = await login({ ajeerCode: '9876543', password: 'nope' }).expect(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('every protected API answers 403 until the password is changed; then normal access', async () => {
    const cookie = cookieOf(
      await login({ ajeerCode: '9000001', password: INITIAL_PASSWORD }).expect(200),
    );
    for (const path of [
      '/api/v1/meta',
      '/api/v1/villages',
      '/api/v1/me/summary',
      '/api/v1/auth/mobile',
    ]) {
      const res = await request(app).get(path).set('Cookie', cookie);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }
    await request(app).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);

    const change = (newPassword: string) =>
      request(app)
        .post('/api/v1/auth/change-password')
        .set('Cookie', cookie)
        .send({ currentPassword: INITIAL_PASSWORD, newPassword });
    expect((await change(INITIAL_PASSWORD).expect(400)).body.error.details.reason).toBe(
      'INITIAL_PASSWORD',
    );
    expect((await change('12345').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await change('9000001').expect(400)).body.error.details.reason).toBe(
      'EQUALS_AJEER_CODE',
    );
    await change('abc123').expect(200);

    await request(app).get('/api/v1/meta').set('Cookie', cookie).expect(200);
    const again = await login({ ajeerCode: '9000001', password: 'abc123' }).expect(200);
    expect(again.body.user.mustChangePassword).toBe(false);
    expect(await AuditLog.countDocuments({ action: 'PASSWORD_CHANGE' })).toBe(1);
  });

  it('the removed verification endpoints no longer exist', async () => {
    const district = await loginCookie(app, '9040001');
    const id = String((await User.findOne({ ajeerCode: ghotki }).lean())!._id);
    for (const path of [
      `/users/${id}/confirm-mobile`,
      `/users/${id}/reject-mobile`,
      `/users/${id}/confirm-mobile-change`,
      `/users/${id}/reject-mobile-change`,
      '/auth/mobile-change',
    ]) {
      await request(app).post(`/api/v1${path}`).set('Cookie', district).expect(404);
    }
    for (const path of [`/users/${id}/pending-mobile`, `/users/${id}/pending-mobile-change`]) {
      await request(app).get(`/api/v1${path}`).set('Cookie', district).expect(404);
    }
  });

  it('supervisors see the optional mobile masked — no verification status', async () => {
    const district = await loginCookie(app, '9040001');
    const res = await request(app).get('/api/v1/users').set('Cookie', district).expect(200);
    const u = (res.body.users as Record<string, unknown>[]).find((x) => x.ajeerCode === ghotki);
    expect(u).toMatchObject({ mobile: '0300•••2233' });
    expect(u).not.toHaveProperty('mobileStatus');
    expect(JSON.stringify(res.body)).not.toContain('03001112233');
    // The old filter is gone: the query parameter is ignored, not an error.
    await request(app)
      .get('/api/v1/users?mobileStatus=unverified')
      .set('Cookie', district)
      .expect(200);
  });
});

describe('own mobile: set, change or remove without any approval (CTO 7 Nov 2026)', () => {
  let arif: string;
  let arifId: string;
  beforeAll(async () => {
    await seedDemo({ reset: true });
    arif = await loginCookie(app, '9090412');
    arifId = String((await User.findOne({ ajeerCode: '9090412' }).lean())!._id);
  });
  const put = (body: object, cookie = arif) =>
    request(app).put('/api/v1/auth/mobile').set('Cookie', cookie).send(body);

  it('needs a session', async () => {
    await request(app).put('/api/v1/auth/mobile').send({ mobile: '03451230002' }).expect(401);
  });

  it('changes at once (any common format), audited with masked numbers', async () => {
    const res = await put({ mobile: '+92 345 1230002' }).expect(200);
    expect(res.body.mobile).toBe('0345•••0002');
    expect((await User.findById(arifId).lean())!.mobile).toBe('03451230002');
    const own = await request(app).get('/api/v1/auth/mobile').set('Cookie', arif).expect(200);
    expect(own.body).toEqual({ mobile: '0345•••0002' });
    const log = await AuditLog.findOne({ action: 'MOBILE_UPDATE', targetId: arifId }).lean();
    expect(log?.details).toEqual({ from: '0300•••0000', to: '0345•••0002' });
    expect(JSON.stringify(log)).not.toContain('03451230002');
    // The same number again changes nothing and writes no audit entry.
    await put({ mobile: '03451230002' }).expect(200);
    expect(await AuditLog.countDocuments({ action: 'MOBILE_UPDATE' })).toBe(1);
  });

  it('refuses an invalid number; empty or null removes it; login still works', async () => {
    const bad = await put({ mobile: '12345' }).expect(400);
    expect(bad.body.error.details.field).toBe('mobile');
    await put({ mobile: '' }).expect(200);
    expect((await User.findById(arifId).lean())!.mobile).toBeUndefined();
    await put({ mobile: '03451230003' }).expect(200);
    await put({ mobile: null }).expect(200);
    expect((await User.findById(arifId).lean())!.mobile).toBeUndefined();
    await login({ ajeerCode: '9090412', password: 'demo1234' }).expect(200);
  });

  it('forgot password matches the number the user set themselves', async () => {
    await put({ mobile: '03451230004' }).expect(200);
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ ajeerCode: '9090412', mobile: '03451230004' })
      .expect(200);
    expect(await PasswordResetRequest.countDocuments({ userId: arifId, status: 'pending' })).toBe(
      1,
    );
  });
});

describe('Pakistan Admin provisioning (CTO 6 Nov 2026)', () => {
  const REFS = {
    nominationRef: 'NOM/2026/014',
    approvalRef: 'APR/2026/031',
    operator: 'Central IT',
  };
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    await seedDemo({ reset: true });
    cookies['9010001'] = await loginCookie(app, '9010001');
  });

  it('provisioning is controlled: references required, never promotes, audited; logs in without a mobile', async () => {
    const bad = (over: Partial<Parameters<typeof provisionPakistanAdmin>[0]>) =>
      provisionPakistanAdmin({ ajeerCode: '9011001', name: 'Central IT One', ...REFS, ...over });
    expect(await bad({ nominationRef: '' })).toMatchObject({ ok: false, reason: 'INVALID' });
    expect(await bad({ approvalRef: ' ' })).toMatchObject({ ok: false, reason: 'INVALID' });
    expect(await bad({ approvalRef: REFS.nominationRef })).toMatchObject({
      ok: false,
      reason: 'INVALID',
    });
    expect(await bad({ operator: '' })).toMatchObject({ ok: false, reason: 'INVALID' });
    // An existing account (here a suba) is refused, never promoted.
    expect(await bad({ ajeerCode: '9020001' })).toMatchObject({ ok: false, reason: 'EXISTS' });
    expect((await User.findOne({ ajeerCode: '9020001' }).lean())!.role).toBe('suba');
    expect(await AuditLog.countDocuments({ action: 'USER_PROVISION' })).toBe(0);

    const ok = await bad({ department: 'CENTRAL_IT' });
    expect(ok).toMatchObject({ ok: true, ajeerCode: '9011001' });
    const u = await User.findOne({ ajeerCode: '9011001' }).lean();
    expect(u).toMatchObject({
      role: 'pakistan',
      unitCode: 'PK',
      unitPath: 'PK',
      department: 'CENTRAL_IT',
      mustChangePassword: true,
      isActive: true,
      isDemo: false,
      provisioned: { nominationRef: REFS.nominationRef, approvalRef: REFS.approvalRef },
    });
    expect(u!.mobile).toBeUndefined();
    const log = await AuditLog.findOne({ action: 'USER_PROVISION' }).lean();
    expect(log).toMatchObject({
      actorAjeerCode: 'Central IT',
      targetType: 'user',
      targetId: String(u!._id),
      details: {
        targetAjeerCode: '9011001',
        role: 'pakistan',
        department: 'CENTRAL_IT',
        nominationRef: REFS.nominationRef,
        approvalRef: REFS.approvalRef,
        isActive: true,
      },
    });
    // First login: Ajeer Code + initial password only, then the forced change.
    const first = await login({ ajeerCode: '9011001', password: INITIAL_PASSWORD }).expect(200);
    expect(first.body.user.mustChangePassword).toBe(true);
    expect(first.body.user).not.toHaveProperty('permissions');
  });

  it('no API creates an account, assigns the pakistan role or grants a permission', async () => {
    const target = await User.findOne({ ajeerCode: '9040001' }).lean();
    const id = String(target!._id);
    const as = cookies['9010001']!;
    await request(app)
      .post('/api/v1/users')
      .set('Cookie', as)
      .send({ ajeerCode: '9011999', role: 'pakistan' })
      .expect(404);
    await request(app)
      .patch(`/api/v1/users/${id}`)
      .set('Cookie', as)
      .send({ role: 'pakistan' })
      .expect(404);
    await request(app)
      .post(`/api/v1/users/${id}/role`)
      .set('Cookie', as)
      .send({ role: 'pakistan' })
      .expect(404);
    await request(app)
      .post(`/api/v1/users/${id}/permissions`)
      .set('Cookie', as)
      .send({ permission: 'ANY' })
      .expect(404);
    expect((await User.findById(id).lean())!.role).toBe('district');
    expect(await User.countDocuments({ ajeerCode: '9011999' })).toBe(0);
  });

  it('Central IT activates / deactivates a Pakistan Admin (audited); sessions stop at once', async () => {
    const r = await provisionPakistanAdmin({ ajeerCode: '9011002', name: 'Admin Two', ...REFS });
    expect(r.ok).toBe(true);
    await User.updateOne(
      { ajeerCode: '9011002' },
      { $set: { passwordHash: await bcrypt.hash('demo1234', 4), mustChangePassword: false } },
    );
    cookies['9011002'] = await loginCookie(app, '9011002');

    const status = (ajeerCode: string, isActive: boolean, reference = 'STS/2026/001') =>
      setPakistanAdminActive({ ajeerCode, isActive, operator: 'Central IT', reference });
    expect(await status('9020001', false)).toMatchObject({ ok: false, reason: 'NOT_CENTRAL' });
    expect(await status('9011002', false, '')).toMatchObject({ ok: false, reason: 'INVALID' });
    expect(await status('9019999', false)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    await request(app).get('/api/v1/auth/me').set('Cookie', cookies['9011002']).expect(200);
    expect(await status('9011002', false)).toEqual({ ok: true, changed: true });
    await request(app).get('/api/v1/auth/me').set('Cookie', cookies['9011002']).expect(401);
    expect(await status('9011002', false)).toEqual({ ok: true, changed: false });
    expect(await status('9011002', true)).toEqual({ ok: true, changed: true });
    // Re-activation does not revive a session from before the deactivation.
    await request(app).get('/api/v1/auth/me').set('Cookie', cookies['9011002']).expect(401);
    const logs = await AuditLog.find({
      action: 'USER_STATUS',
      'details.targetAjeerCode': '9011002',
    })
      .sort({ at: 1 })
      .lean();
    expect(
      logs.map((l) => [l.actorAjeerCode, (l.details as { isActive: boolean }).isActive]),
    ).toEqual([
      ['Central IT', false],
      ['Central IT', true],
    ]);
    // The API cannot do it: no supervisor outranks a pakistan account.
    const target = await User.findOne({ ajeerCode: '9011002' }).lean();
    await request(app)
      .post(`/api/v1/users/${String(target!._id)}/status`)
      .set('Cookie', cookies['9010001']!)
      .send({ isActive: false })
      .expect(403);
  });
});

describe('forgot password → district reset', () => {
  let arifId: string;
  let larkanaUserId: string;

  beforeAll(async () => {
    await seedDemo({ reset: true });
    arifId = String((await User.findOne({ ajeerCode: '9090412' }).lean())!._id);
    larkanaUserId = String(
      (await User.findOne({ role: 'zimmedar', unitCode: 'LARKANA_DIST' }).lean())!._id,
    );
  });

  it('answers the same whether or not the details match, and only matches open a request', async () => {
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ ajeerCode: '9090412', mobile: '03119999999' })
      .expect(200);
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ ajeerCode: '55555', mobile: '03000000000' })
      .expect(200);
    expect(await PasswordResetRequest.countDocuments()).toBe(0);

    for (let i = 0; i < 2; i += 1) {
      await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ ajeerCode: '9090412', mobile: '0300 0000000' })
        .expect(200);
    }
    expect(await PasswordResetRequest.countDocuments({ status: 'pending' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'PASSWORD_RESET_REQUEST' })).toBe(1);
  });

  it('without a mobile no request is opened (same answer) — the supervisor resets directly', async () => {
    const other = await User.findOne({
      role: 'zimmedar',
      unitCode: 'GHOTKI',
      ajeerCode: { $ne: '9090412' },
    }).lean();
    await User.updateOne({ _id: other!._id }, { $unset: { mobile: 1 } });
    // A fresh app: the per-IP forgot-password limit of the shared one is used up above.
    await request(createApp())
      .post('/api/v1/auth/forgot-password')
      .send({ ajeerCode: other!.ajeerCode, mobile: '03000000000' })
      .expect(200);
    expect(await PasswordResetRequest.countDocuments({ userId: other!._id })).toBe(0);
  });

  it('shows the request to the district (and above), not to other districts', async () => {
    const district = await loginCookie(app, '9040001');
    const res = await request(app)
      .get('/api/v1/users/reset-requests')
      .set('Cookie', district)
      .expect(200);
    expect(res.body.requests).toEqual([
      expect.objectContaining({ ajeerCode: '9090412', userId: arifId, unitCode: 'GHOTKI' }),
    ]);

    const other = await User.findOne({
      role: 'zimmedar',
      unitCode: 'GHOTKI',
      ajeerCode: { $ne: '9090412' },
    }).lean();
    const zimmedar = await loginCookie(app, other!.ajeerCode);
    await request(app).get('/api/v1/users/reset-requests').set('Cookie', zimmedar).expect(403);
  });

  it('district resets: initial password, change forced, old sessions end, request closed, audited', async () => {
    // Two devices logged in before the reset (cookie and Bearer).
    const phone = await loginCookie(app, '9090412');
    const loginRes = await login({ ajeerCode: '9090412', password: 'demo1234' }).expect(200);
    const bearer = String(loginRes.headers['set-cookie']).split(';')[0]!.split('=')[1]!;
    await request(app).get('/api/v1/meta').set('Cookie', phone).expect(200);
    await request(app).get('/api/v1/meta').set('Authorization', `Bearer ${bearer}`).expect(200);

    const district = await loginCookie(app, '9040001');
    await request(app)
      .post(`/api/v1/users/${arifId}/reset-password`)
      .set('Cookie', district)
      .expect(200);

    // Every session issued before the reset is dead — also for /auth/me and change-password,
    // so an old device cannot set a new password with the initial password.
    await request(app).get('/api/v1/meta').set('Cookie', phone).expect(401);
    await request(app).get('/api/v1/auth/me').set('Cookie', phone).expect(401);
    await request(app).get('/api/v1/meta').set('Authorization', `Bearer ${bearer}`).expect(401);
    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Cookie', phone)
      .send({ currentPassword: INITIAL_PASSWORD, newPassword: 'taken-over' })
      .expect(401);

    expect(await PasswordResetRequest.countDocuments({ status: 'pending' })).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'PASSWORD_RESET', targetId: arifId })).toBe(1);

    // The new login needs only the initial password (no mobile) and forces a change.
    const res = await login({ ajeerCode: '9090412', password: INITIAL_PASSWORD }).expect(200);
    expect(res.body.user.mustChangePassword).toBe(true);
  });

  it('district can reset directly (no request), but only its own lower-level users', async () => {
    const district = await loginCookie(app, '9040001');
    await request(app)
      .post(`/api/v1/users/${larkanaUserId}/reset-password`)
      .set('Cookie', district)
      .expect(404);

    const division = await loginCookie(app, '9030001');
    const district40001 = String((await User.findOne({ ajeerCode: '9040001' }).lean())!._id);
    await request(app)
      .post(`/api/v1/users/${district40001}/reset-password`)
      .set('Cookie', division)
      .expect(200);

    const self = String((await User.findOne({ ajeerCode: '9030001' }).lean())!._id);
    await request(app)
      .post(`/api/v1/users/${self}/reset-password`)
      .set('Cookie', division)
      .expect(403);
  });
});

import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { AuditLog } from '../../models/audit-log.js';
import { PasswordResetRequest } from '../../models/password-reset-request.js';
import { User } from '../../models/user.js';
import { seedDemo } from '../../seed/seed.js';

const app = createApp();

/** Put a seeded user into the "imported, never logged in" state: password 123 + mustChangePassword. */
async function makeNewUser(ajeerCode: string, mobile?: string): Promise<void> {
  const passwordHash = await bcrypt.hash('123', 4);
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

describe('first login with the initial password 123', () => {
  let noMobile = ''; // a Ghotki zimmedar, so the demo district 9040001 can confirm the number
  beforeAll(async () => {
    await seedDemo({ reset: true });
    await makeNewUser('9000001', '03001112233');
    noMobile = (await User.findOne({
      unitCode: 'GHOTKI',
      role: 'zimmedar',
      ajeerCode: { $ne: '9090412' },
    }).lean())!.ajeerCode;
    await makeNewUser(noMobile);
  });

  it('asks for the registered mobile, without counting it as a failed login', async () => {
    for (let i = 0; i < 6; i += 1) {
      const res = await login({ ajeerCode: '9000001', password: '123' }).expect(401);
      expect(res.body.error.code).toBe('MOBILE_REQUIRED');
    }
  });

  it('rejects a mobile that does not match', async () => {
    const res = await login({
      ajeerCode: '9000001',
      password: '123',
      mobile: '03009999999',
    }).expect(401);
    expect(res.body.error.code).toBe('MOBILE_MISMATCH');
  });

  it('without a number on record: saved as "tasdeeq baqi", no session until the District confirms', async () => {
    const bad = await login({ ajeerCode: noMobile, password: '123', mobile: '12345' }).expect(400);
    expect(bad.body.error.details.field).toBe('mobile');

    const first = await login({ ajeerCode: noMobile, password: '123', mobile: '0301 2223344' });
    expect(first.status).toBe(403);
    expect(first.body.error.code).toBe('MOBILE_PENDING');
    expect(first.headers['set-cookie']).toBeUndefined(); // no session before confirmation
    const saved = await User.findOne({ ajeerCode: noMobile }).lean();
    expect(saved).toMatchObject({ mobile: '03012223344', mobileVerified: false });
    expect(
      await AuditLog.countDocuments({ action: 'MOBILE_SELF_REGISTER', actorAjeerCode: noMobile }),
    ).toBe(1);
    // From now on that number is the one checked; even the right one waits for the District.
    const other = await login({ ajeerCode: noMobile, password: '123', mobile: '03009999999' });
    expect(other.body.error.code).toBe('MOBILE_MISMATCH');
    const again = await login({ ajeerCode: noMobile, password: '123', mobile: '03012223344' });
    expect(again.body.error.code).toBe('MOBILE_PENDING');
    // A pending number is not a registered number for forgot-password either.
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ ajeerCode: noMobile, mobile: '03012223344' })
      .expect(200);
    expect(await PasswordResetRequest.countDocuments({ ajeerCode: noMobile })).toBe(0);

    // The District sees it as unverified and confirms it (audited); then the login goes on.
    const district = await loginCookie(app, '9040001');
    const list = await request(app)
      .get('/api/v1/users?mobileStatus=unverified')
      .set('Cookie', district)
      .expect(200);
    const row = (list.body.users as { id: string; ajeerCode: string; mobileStatus: string }[]).find(
      (u) => u.ajeerCode === noMobile,
    );
    expect(row?.mobileStatus).toBe('unverified');
    await request(app)
      .post(`/api/v1/users/${row!.id}/confirm-mobile`)
      .set('Cookie', district)
      .expect(200);
    expect((await User.findOne({ ajeerCode: noMobile }).lean())?.mobileVerified).toBe(true);
    expect(await AuditLog.countDocuments({ action: 'MOBILE_CONFIRM' })).toBe(1);
    // Confirming twice is a conflict, not a second audit entry.
    await request(app)
      .post(`/api/v1/users/${row!.id}/confirm-mobile`)
      .set('Cookie', district)
      .expect(409);
    const ok = await login({ ajeerCode: noMobile, password: '123', mobile: '03012223344' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.mustChangePassword).toBe(true);
  });

  it('the District can reject a wrong self-entered number (audited); the user types it again', async () => {
    const z = await User.findOne({
      unitCode: 'GHOTKI',
      role: 'zimmedar',
      ajeerCode: { $nin: ['9090412', noMobile] },
    }).lean();
    await makeNewUser(z!.ajeerCode);
    await login({ ajeerCode: z!.ajeerCode, password: '123', mobile: '03015556677' }).expect(403);

    const district = await loginCookie(app, '9040001');
    const division = await loginCookie(app, '9030001'); // read-only for mobiles (CTO 5 Nov)
    // Out of scope → 404: a zimmedar of another district cannot be touched by Ghotki.
    const outside = await User.findOne({ role: 'zimmedar', unitCode: { $ne: 'GHOTKI' } }).lean();
    await request(app)
      .post(`/api/v1/users/${String(outside!._id)}/reject-mobile`)
      .set('Cookie', district)
      .expect(404);
    // Division and above may not verify or reject (403), even inside their scope.
    await request(app)
      .post(`/api/v1/users/${String(z!._id)}/reject-mobile`)
      .set('Cookie', division)
      .expect(403);
    await request(app)
      .post(`/api/v1/users/${String(z!._id)}/confirm-mobile`)
      .set('Cookie', division)
      .expect(403);
    await request(app)
      .post(`/api/v1/users/${String(z!._id)}/reject-mobile`)
      .set('Cookie', district)
      .expect(200);
    const after = await User.findOne({ _id: z!._id }).lean();
    expect(after?.mobile).toBeUndefined();
    expect(after?.mobileVerified).toBeUndefined();
    expect(
      await AuditLog.countDocuments({ action: 'MOBILE_REJECT', targetId: String(z!._id) }),
    ).toBe(1);
    // Nothing left to reject.
    await request(app)
      .post(`/api/v1/users/${String(z!._id)}/reject-mobile`)
      .set('Cookie', district)
      .expect(409);
    // The division still sees the status read-only (masked).
    const seen = await request(app)
      .get('/api/v1/users?mobileStatus=unverified')
      .set('Cookie', division)
      .expect(200);
    expect(JSON.stringify(seen.body)).not.toContain('03015556677');
    // The user can now type the right number (again pending).
    const retry = await login({ ajeerCode: z!.ajeerCode, password: '123', mobile: '03017778899' });
    expect(retry.body.error.code).toBe('MOBILE_PENDING');
  });

  it('confirm / reject: only lower-level users in scope; audits keep the number masked', async () => {
    const z = await User.findOne({
      unitCode: 'GHOTKI',
      role: 'zimmedar',
      ajeerCode: { $nin: ['9090412', noMobile] },
    })
      .sort({ ajeerCode: -1 })
      .lean();
    await makeNewUser(z!.ajeerCode);
    // A correct password with a pending number is not a failed login: no rate limit.
    for (let i = 0; i < 7; i += 1) {
      const res = await login({ ajeerCode: z!.ajeerCode, password: '123', mobile: '03024445566' });
      expect(res.body.error.code).toBe('MOBILE_PENDING');
    }
    const id = String(z!._id);
    const district = await loginCookie(app, '9040001');
    const zimmedar = await loginCookie(app, '9090412');
    const districtId = String((await User.findOne({ ajeerCode: '9040001' }).lean())!._id);
    // A zimmedar cannot confirm anything; a district cannot confirm itself (same level).
    await request(app)
      .post(`/api/v1/users/${id}/confirm-mobile`)
      .set('Cookie', zimmedar)
      .expect(403);
    await request(app)
      .post(`/api/v1/users/${districtId}/reject-mobile`)
      .set('Cookie', district)
      .expect(403);
    // The District sees the full pending number (audited, masked in the log); nobody else does.
    const view = await request(app)
      .get(`/api/v1/users/${id}/pending-mobile`)
      .set('Cookie', district)
      .expect(200);
    expect(view.body).toEqual({ mobile: '03024445566' });
    expect(view.headers['cache-control']).toBe('no-store');
    const division = await loginCookie(app, '9030001');
    await request(app)
      .get(`/api/v1/users/${id}/pending-mobile`)
      .set('Cookie', division)
      .expect(403);
    await request(app)
      .get(`/api/v1/users/${id}/pending-mobile`)
      .set('Cookie', zimmedar)
      .expect(403);
    const outside = await User.findOne({ role: 'zimmedar', unitCode: { $ne: 'GHOTKI' } }).lean();
    await request(app)
      .get(`/api/v1/users/${String(outside!._id)}/pending-mobile`)
      .set('Cookie', district)
      .expect(404);
    expect(await AuditLog.countDocuments({ action: 'MOBILE_VIEW', targetId: id })).toBe(1);

    await request(app)
      .post(`/api/v1/users/${id}/confirm-mobile`)
      .set('Cookie', district)
      .expect(200);
    // Confirmed → no pending number left to show.
    await request(app)
      .get(`/api/v1/users/${id}/pending-mobile`)
      .set('Cookie', district)
      .expect(409);

    const audits = await AuditLog.find({
      action: { $in: ['MOBILE_SELF_REGISTER', 'MOBILE_CONFIRM', 'MOBILE_REJECT', 'MOBILE_VIEW'] },
    }).lean();
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) {
      const shown = String((a.details as { mobile?: string } | undefined)?.mobile ?? '');
      expect(shown).toMatch(/^03\d{2}•••\d{4}$/);
    }
    expect(JSON.stringify(audits)).not.toContain('03024445566');
  });

  it('a user whose mobile is still pending cannot use an older session', async () => {
    const z = await User.findOne({ ajeerCode: '9090412' }).lean();
    const cookie = await loginCookie(app, '9090412');
    await request(app).get('/api/v1/meta').set('Cookie', cookie).expect(200);
    await User.updateOne({ _id: z!._id }, { $set: { mobileVerified: false } });
    const res = await request(app).get('/api/v1/meta').set('Cookie', cookie).expect(403);
    expect(res.body.error.code).toBe('MOBILE_PENDING');
    await request(app).get('/api/v1/auth/me').set('Cookie', cookie).expect(403);
    await User.updateOne({ _id: z!._id }, { $set: { mobileVerified: true } });
  });

  it('logs in when the mobile matches (any common format) and forces a password change', async () => {
    const res = await login({
      ajeerCode: '9000001',
      password: '123',
      mobile: '+92 300-1112233',
    }).expect(200);
    expect(res.body.user.mustChangePassword).toBe(true);
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;

    // Everything except me / change-password is closed until the password is changed.
    const blocked = await request(app).get('/api/v1/meta').set('Cookie', cookie).expect(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await request(app).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);

    const change = (newPassword: string) =>
      request(app)
        .post('/api/v1/auth/change-password')
        .set('Cookie', cookie)
        .send({ currentPassword: '123', newPassword });

    expect((await change('123').expect(400)).body.error.code).toBe('VALIDATION_FAILED'); // too short
    expect((await change('12345').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await change('9000001').expect(400)).body.error.details.reason).toBe(
      'EQUALS_AJEER_CODE',
    );
    await change('abc123').expect(200);

    await request(app).get('/api/v1/meta').set('Cookie', cookie).expect(200);
    const again = await login({ ajeerCode: '9000001', password: 'abc123' }).expect(200);
    expect(again.body.user.mustChangePassword).toBe(false);
  });
});

describe('mobile verification one level up (CTO 5 Nov 2026)', () => {
  // New supervisor accounts without a mobile, one per level, inside the demo hierarchy.
  const ACCOUNTS = [
    {
      ajeerCode: '9040099',
      role: 'district',
      unitCode: 'GHOTKI',
      unitPath: 'PK/INT_SINDH/SUKKUR/GHOTKI',
    },
    { ajeerCode: '9030099', role: 'division', unitCode: 'SUKKUR', unitPath: 'PK/INT_SINDH/SUKKUR' },
    { ajeerCode: '9020099', role: 'suba', unitCode: 'INT_SINDH', unitPath: 'PK/INT_SINDH' },
    { ajeerCode: '9010099', role: 'pakistan', unitCode: 'PK', unitPath: 'PK' },
  ] as const;
  const ids: Record<string, string> = {};
  let cookies: Record<string, string> = {};
  const act = (code: string, id: string, action: string) =>
    request(app).post(`/api/v1/users/${id}/${action}`).set('Cookie', cookies[code]!);

  beforeAll(async () => {
    await seedDemo({ reset: true });
    const passwordHash = await bcrypt.hash('123', 4);
    for (const a of ACCOUNTS) {
      const u = await User.create({
        ...a,
        name: `Test ${a.role}`,
        passwordHash,
        mustChangePassword: true,
      });
      ids[a.ajeerCode] = String(u._id);
      // First login with a self-entered number → pending, no session.
      const res = await login({ ajeerCode: a.ajeerCode, password: '123', mobile: '03031112233' });
      expect(res.body.error.code).toBe('MOBILE_PENDING');
    }
    cookies = {
      '9040001': await loginCookie(app, '9040001'),
      '9030001': await loginCookie(app, '9030001'),
      '9020001': await loginCookie(app, '9020001'),
      '9010001': await loginCookie(app, '9010001'),
    };
  });

  it('a district account: not by another district or the suba — by its division', async () => {
    const id = ids['9040099']!;
    await act('9040001', id, 'confirm-mobile').expect(403); // same level
    await act('9020001', id, 'confirm-mobile').expect(403); // two levels up
    await request(app)
      .get(`/api/v1/users/${id}/pending-mobile`)
      .set('Cookie', cookies['9030001']!)
      .expect(200);
    await act('9030001', id, 'confirm-mobile').expect(200);
    const ok = await login({ ajeerCode: '9040099', password: '123', mobile: '03031112233' }).expect(
      200,
    );
    expect(ok.body.user.mustChangePassword).toBe(true);
  });

  it('a division account by its suba; a suba account by pakistan', async () => {
    await act('9030001', ids['9030099']!, 'confirm-mobile').expect(403);
    await act('9020001', ids['9030099']!, 'confirm-mobile').expect(200);
    await act('9020001', ids['9020099']!, 'reject-mobile').expect(403);
    await act('9010001', ids['9020099']!, 'reject-mobile').expect(200);
    const confirms = await AuditLog.find({
      action: { $in: ['MOBILE_CONFIRM', 'MOBILE_REJECT'] },
    }).lean();
    expect(
      confirms.map((a) => [
        a.action,
        a.actorAjeerCode,
        (a.details as { targetAjeerCode: string }).targetAjeerCode,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['MOBILE_CONFIRM', '9030001', '9040099'],
        ['MOBILE_CONFIRM', '9020001', '9030099'],
        ['MOBILE_REJECT', '9010001', '9020099'],
      ]),
    );
  });

  it('a pakistan account has no verifier yet (no self- or same-level verification)', async () => {
    const id = ids['9010099']!;
    await act('9010001', id, 'confirm-mobile').expect(403);
    await request(app)
      .get(`/api/v1/users/${id}/pending-mobile`)
      .set('Cookie', cookies['9010001']!)
      .expect(403);
    const still = await login({ ajeerCode: '9010099', password: '123', mobile: '03031112233' });
    expect(still.body.error.code).toBe('MOBILE_PENDING');
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

  it('district resets: password back to 123, change forced, request closed, audited', async () => {
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
    // so an old device cannot set a new password with "123".
    await request(app).get('/api/v1/meta').set('Cookie', phone).expect(401);
    await request(app).get('/api/v1/auth/me').set('Cookie', phone).expect(401);
    await request(app).get('/api/v1/meta').set('Authorization', `Bearer ${bearer}`).expect(401);
    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Cookie', phone)
      .send({ currentPassword: '123', newPassword: 'taken-over' })
      .expect(401);

    expect(await PasswordResetRequest.countDocuments({ status: 'pending' })).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'PASSWORD_RESET', targetId: arifId })).toBe(1);

    await login({ ajeerCode: '9090412', password: 'demo1234' }).expect(401);
    const res = await login({
      ajeerCode: '9090412',
      password: '123',
      mobile: '03000000000',
    }).expect(200);
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

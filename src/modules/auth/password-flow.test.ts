import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { AuditLog } from '../../models/audit-log.js';
import { PasswordResetRequest } from '../../models/password-reset-request.js';
import { User } from '../../models/user.js';
import { seedDemo } from '../../seed/seed.js';
import { setPermission } from '../users/permissions.js';
import { INITIAL_PASSWORD } from './schemas.js';
import { provisionPakistanAdmin, setPakistanAdminActive } from '../users/provision.js';

const app = createApp();

/** Put a seeded user into the "imported, never logged in" state: initial password + mustChangePassword. */
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
      const res = await login({ ajeerCode: '9000001', password: INITIAL_PASSWORD }).expect(401);
      expect(res.body.error.code).toBe('MOBILE_REQUIRED');
    }
  });

  it('rejects a mobile that does not match', async () => {
    const res = await login({
      ajeerCode: '9000001',
      password: INITIAL_PASSWORD,
      mobile: '03009999999',
    }).expect(401);
    expect(res.body.error.code).toBe('MOBILE_MISMATCH');
  });

  it('without a number on record: saved as "tasdeeq baqi", no session until the District confirms', async () => {
    const bad = await login({
      ajeerCode: noMobile,
      password: INITIAL_PASSWORD,
      mobile: '12345',
    }).expect(400);
    expect(bad.body.error.details.field).toBe('mobile');

    const first = await login({
      ajeerCode: noMobile,
      password: INITIAL_PASSWORD,
      mobile: '0301 2223344',
    });
    expect(first.status).toBe(403);
    expect(first.body.error.code).toBe('MOBILE_PENDING');
    expect(first.headers['set-cookie']).toBeUndefined(); // no session before confirmation
    const saved = await User.findOne({ ajeerCode: noMobile }).lean();
    expect(saved).toMatchObject({ mobile: '03012223344', mobileVerified: false });
    expect(
      await AuditLog.countDocuments({ action: 'MOBILE_SELF_REGISTER', actorAjeerCode: noMobile }),
    ).toBe(1);
    // From now on that number is the one checked; even the right one waits for the District.
    const other = await login({
      ajeerCode: noMobile,
      password: INITIAL_PASSWORD,
      mobile: '03009999999',
    });
    expect(other.body.error.code).toBe('MOBILE_MISMATCH');
    const again = await login({
      ajeerCode: noMobile,
      password: INITIAL_PASSWORD,
      mobile: '03012223344',
    });
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
    const ok = await login({
      ajeerCode: noMobile,
      password: INITIAL_PASSWORD,
      mobile: '03012223344',
    });
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
    await login({
      ajeerCode: z!.ajeerCode,
      password: INITIAL_PASSWORD,
      mobile: '03015556677',
    }).expect(403);

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
    const retry = await login({
      ajeerCode: z!.ajeerCode,
      password: INITIAL_PASSWORD,
      mobile: '03017778899',
    });
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
      const res = await login({
        ajeerCode: z!.ajeerCode,
        password: INITIAL_PASSWORD,
        mobile: '03024445566',
      });
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
      password: INITIAL_PASSWORD,
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
    const passwordHash = await bcrypt.hash(INITIAL_PASSWORD, 4);
    for (const a of ACCOUNTS) {
      const u = await User.create({
        ...a,
        name: `Test ${a.role}`,
        passwordHash,
        mustChangePassword: true,
      });
      ids[a.ajeerCode] = String(u._id);
      // First login with a self-entered number → pending, no session.
      const res = await login({
        ajeerCode: a.ajeerCode,
        password: INITIAL_PASSWORD,
        mobile: '03031112233',
      });
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
    const ok = await login({
      ajeerCode: '9040099',
      password: INITIAL_PASSWORD,
      mobile: '03031112233',
    }).expect(200);
    expect(ok.body.user.mustChangePassword).toBe(true);
  });

  it('a division account by its suba; a suba account only by the designated Pakistan Admin', async () => {
    await act('9030001', ids['9030099']!, 'confirm-mobile').expect(403);
    await act('9020001', ids['9030099']!, 'confirm-mobile').expect(200);
    await act('9020001', ids['9020099']!, 'reject-mobile').expect(403);
    // The pakistan role alone is not enough.
    await act('9010001', ids['9020099']!, 'reject-mobile').expect(403);
    await request(app)
      .get(`/api/v1/users/${ids['9020099']!}/pending-mobile`)
      .set('Cookie', cookies['9010001']!)
      .expect(403);
    // Designated explicitly (audited); the same session gets it on its next request.
    expect(
      await setPermission({
        ajeerCode: '9010001',
        permission: 'VERIFY_SUBA_MOBILE',
        grant: true,
        actor: 'test',
      }),
    ).toMatchObject({ ok: true, changed: true });
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', cookies['9010001']!)
      .expect(200);
    expect(me.body.user.permissions).toEqual(['VERIFY_SUBA_MOBILE']);
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

  it('the designated admin verifies suba accounts only, not lower levels', async () => {
    const passwordHash = await bcrypt.hash(INITIAL_PASSWORD, 4);
    const div = await User.create({
      ajeerCode: '9030098',
      role: 'division',
      unitCode: 'SUKKUR',
      unitPath: 'PK/INT_SINDH/SUKKUR',
      name: 'Test division 2',
      passwordHash,
      mustChangePassword: true,
    });
    await login({ ajeerCode: '9030098', password: INITIAL_PASSWORD, mobile: '03031114455' }).expect(
      403,
    );
    await act('9010001', String(div._id), 'confirm-mobile').expect(403); // two levels up
    await act('9020001', String(div._id), 'confirm-mobile').expect(200);
  });

  it('a permission is given only to an active pakistan account, explicitly and audited', async () => {
    expect(
      await setPermission({
        ajeerCode: '9020001',
        permission: 'VERIFY_SUBA_MOBILE',
        grant: true,
        actor: 'test',
      }),
    ).toEqual({ ok: false, reason: 'WRONG_ROLE' });
    expect(
      await setPermission({
        ajeerCode: '9999999',
        permission: 'VERIFY_SUBA_MOBILE',
        grant: true,
        actor: 'test',
      }),
    ).toEqual({ ok: false, reason: 'NOT_FOUND' });
    await User.updateOne({ ajeerCode: '9010099' }, { $set: { isActive: false } });
    expect(
      await setPermission({
        ajeerCode: '9010099',
        permission: 'VERIFY_SUBA_MOBILE',
        grant: true,
        actor: 'test',
      }),
    ).toEqual({ ok: false, reason: 'INACTIVE' });
    await User.updateOne({ ajeerCode: '9010099' }, { $set: { isActive: true } });
    // Again on the designated admin: no change, no second audit entry.
    expect(
      await setPermission({
        ajeerCode: '9010001',
        permission: 'VERIFY_SUBA_MOBILE',
        grant: true,
        actor: 'test',
      }),
    ).toMatchObject({ ok: true, changed: false });
    expect(await AuditLog.countDocuments({ action: 'USER_PERMISSION' })).toBe(1);
    // Revoke → the next request has no permission any more.
    await setPermission({
      ajeerCode: '9010001',
      permission: 'VERIFY_SUBA_MOBILE',
      grant: false,
      actor: 'test',
    });
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', cookies['9010001']!)
      .expect(200);
    expect(me.body.user.permissions).toEqual([]);
    expect(await AuditLog.countDocuments({ action: 'USER_PERMISSION' })).toBe(2);
  });

  it('a revoked admin and a non-pakistan holder of the permission are both refused', async () => {
    const passwordHash = await bcrypt.hash(INITIAL_PASSWORD, 4);
    const suba = await User.create({
      ajeerCode: '9020098',
      role: 'suba',
      unitCode: 'INT_SINDH',
      unitPath: 'PK/INT_SINDH',
      name: 'Test suba 2',
      passwordHash,
      mustChangePassword: true,
    });
    const id = String(suba._id);
    await login({ ajeerCode: '9020098', password: INITIAL_PASSWORD, mobile: '03031116677' }).expect(
      403,
    );
    // The revoked admin's existing session: every verification endpoint refuses.
    await act('9010001', id, 'confirm-mobile').expect(403);
    await act('9010001', id, 'reject-mobile').expect(403);
    await request(app)
      .get(`/api/v1/users/${id}/pending-mobile`)
      .set('Cookie', cookies['9010001']!)
      .expect(403);
    // The permission written straight into the database for a suba account (setPermission would
    // refuse it): the role half of the check still refuses.
    await User.updateOne(
      { ajeerCode: '9020001' },
      { $set: { permissions: ['VERIFY_SUBA_MOBILE'] } },
    );
    await act('9020001', id, 'confirm-mobile').expect(403);
    await act('9020001', id, 'reject-mobile').expect(403);
    await request(app)
      .get(`/api/v1/users/${id}/pending-mobile`)
      .set('Cookie', cookies['9020001']!)
      .expect(403);
    await User.updateOne({ ajeerCode: '9020001' }, { $set: { permissions: [] } });
    const still = await login({
      ajeerCode: '9020098',
      password: INITIAL_PASSWORD,
      mobile: '03031116677',
    });
    expect(still.body.error.code).toBe('MOBILE_PENDING');
  });

  it('a pakistan account: not the designated Pakistan Admin (only the Central IT verifier)', async () => {
    const id = ids['9010099']!;
    await setPermission({
      ajeerCode: '9010001',
      permission: 'VERIFY_SUBA_MOBILE',
      grant: true,
      actor: 'test',
    });
    await act('9010001', id, 'confirm-mobile').expect(403);
    await act('9010001', id, 'reject-mobile').expect(403);
    await request(app)
      .get(`/api/v1/users/${id}/pending-mobile`)
      .set('Cookie', cookies['9010001']!)
      .expect(403);
    const still = await login({
      ajeerCode: '9010099',
      password: INITIAL_PASSWORD,
      mobile: '03031112233',
    });
    expect(still.body.error.code).toBe('MOBILE_PENDING');
  });
});

describe('Pakistan Admin provisioning and Central IT mobile verification (CTO 6 Nov 2026)', () => {
  const REFS = {
    nominationRef: 'NOM/2026/014',
    approvalRef: 'APR/2026/031',
    operator: 'Central IT',
  };
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const act = (who: string, id: string, action: string) =>
    action === 'pending-mobile'
      ? request(app).get(`/api/v1/users/${id}/pending-mobile`).set('Cookie', cookies[who]!)
      : request(app).post(`/api/v1/users/${id}/${action}`).set('Cookie', cookies[who]!);
  const all3 = async (who: string, id: string, status: number) => {
    await act(who, id, 'pending-mobile').expect(status);
    await act(who, id, 'confirm-mobile').expect(status);
    await act(who, id, 'reject-mobile').expect(status);
  };
  /**
   * Test fixture only: give a provisioned account a usable login without the API. In the real
   * process the first Central IT verifier's own mobile has no verifier yet (see scope §1 —
   * open CTO dependency); this stands in for that step on the in-memory test database.
   */
  const usable = async (ajeerCode: string, mobile: string) => {
    await User.updateOne(
      { ajeerCode },
      {
        $set: {
          mobile,
          mobileVerified: true,
          passwordHash: await bcrypt.hash('demo1234', 4),
          mustChangePassword: false,
        },
      },
    );
    cookies[ajeerCode] = await loginCookie(app, ajeerCode);
  };
  /** A provisioned Pakistan Admin whose self-entered mobile now waits for confirmation. */
  const pendingAdmin = async (ajeerCode: string, mobile: string) => {
    const r = await provisionPakistanAdmin({ ajeerCode, name: `Admin ${ajeerCode}`, ...REFS });
    if (!r.ok) throw new Error(r.reason);
    ids[ajeerCode] = r.id;
    const res = await login({ ajeerCode, password: INITIAL_PASSWORD, mobile });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MOBILE_PENDING');
    expect(res.headers['set-cookie']).toBeUndefined(); // no session before verification
  };

  beforeAll(async () => {
    await seedDemo({ reset: true });
    cookies['9010001'] = await loginCookie(app, '9010001');
    cookies['9020001'] = await loginCookie(app, '9020001');
  });

  it('provisioning is controlled: references required, never promotes, nothing implied, audited', async () => {
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
      permissions: [],
      mustChangePassword: true,
      isActive: true,
      isDemo: false,
      provisioned: { nominationRef: REFS.nominationRef, approvalRef: REFS.approvalRef },
    });
    expect(u!.mobile).toBeUndefined(); // creation never verifies (or sets) a mobile
    expect(u!.mobileVerified).toBeUndefined();
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
        permissions: [],
      },
    });
    // First login: the typed mobile waits — no session.
    const first = await login({
      ajeerCode: '9011001',
      password: INITIAL_PASSWORD,
      mobile: '03031230001',
    });
    expect(first.body.error.code).toBe('MOBILE_PENDING');
    expect(first.headers['set-cookie']).toBeUndefined();
  });

  it('no API creates an account or assigns the pakistan role', async () => {
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
      .send({ permission: 'VERIFY_PAKISTAN_MOBILE' })
      .expect(404);
    expect((await User.findById(id).lean())!.role).toBe('district');
    expect(await User.countDocuments({ ajeerCode: '9011999' })).toBe(0);
  });

  it('VERIFY_PAKISTAN_MOBILE goes only to a Central IT pakistan account', async () => {
    const grant = (ajeerCode: string) =>
      setPermission({
        ajeerCode,
        permission: 'VERIFY_PAKISTAN_MOBILE',
        grant: true,
        actor: 'test',
      });
    expect(await grant('9010001')).toEqual({ ok: false, reason: 'WRONG_DEPARTMENT' });
    expect(await grant('9020001')).toEqual({ ok: false, reason: 'WRONG_ROLE' });
    expect(await grant('9011001')).toMatchObject({ ok: true, changed: true });
    expect(
      await AuditLog.findOne({
        action: 'USER_PERMISSION',
        'details.targetAjeerCode': '9011001',
      }).lean(),
    ).toMatchObject({ details: { permission: 'VERIFY_PAKISTAN_MOBILE', granted: true } });
  });

  it('the designated Central IT verifier verifies and rejects a Pakistan Admin mobile; nobody else', async () => {
    await usable('9011001', '03031230001'); // the designated Central IT verifier (see `usable`)
    // An ordinary Central IT account without the permission.
    const plain = await provisionPakistanAdmin({
      ajeerCode: '9011002',
      name: 'Central IT Two',
      ...REFS,
      department: 'CENTRAL_IT',
    });
    expect(plain.ok).toBe(true);
    await usable('9011002', '03031230002');
    await pendingAdmin('9011003', '03031230003');
    const id = ids['9011003']!;

    // Unauthorized: ordinary Pakistan Admin (even holding VERIFY_SUBA_MOBILE), Central IT without
    // the permission, suba.
    await setPermission({
      ajeerCode: '9010001',
      permission: 'VERIFY_SUBA_MOBILE',
      grant: true,
      actor: 'test',
    });
    await all3('9010001', id, 403);
    await all3('9011002', id, 403);
    await all3('9020001', id, 404); // a pakistan account is outside the suba's scope
    // The pending list: only the Central IT verifier sees pending pakistan accounts (never itself).
    const listed = async (who: string) =>
      (
        (
          await request(app)
            .get('/api/v1/users?mobileStatus=unverified')
            .set('Cookie', cookies[who]!)
            .expect(200)
        ).body.users as { ajeerCode: string }[]
      ).map((u) => u.ajeerCode);
    expect(await listed('9011001')).toContain('9011003');
    expect(await listed('9011001')).not.toContain('9011001');
    expect(await listed('9010001')).not.toContain('9011003');
    expect(await listed('9011002')).not.toContain('9011003');

    // Reject: number removed, the person types it again — still no session.
    await act('9011001', id, 'pending-mobile').expect(200);
    await act('9011001', id, 'reject-mobile').expect(200);
    const again = await login({
      ajeerCode: '9011003',
      password: INITIAL_PASSWORD,
      mobile: '03031230033',
    });
    expect(again.body.error.code).toBe('MOBILE_PENDING');
    // Confirm: now the login works (forced password change next).
    await act('9011001', id, 'confirm-mobile').expect(200);
    const ok = await login({
      ajeerCode: '9011003',
      password: INITIAL_PASSWORD,
      mobile: '03031230033',
    }).expect(200);
    expect(ok.body.user.mustChangePassword).toBe(true);

    const logs = await AuditLog.find({
      action: { $in: ['MOBILE_REJECT', 'MOBILE_CONFIRM'] },
      targetId: id,
    })
      .sort({ at: 1 })
      .lean();
    expect(
      logs.map((l) => [
        l.action,
        l.actorAjeerCode,
        (l.details as { targetAjeerCode: string }).targetAjeerCode,
      ]),
    ).toEqual([
      ['MOBILE_REJECT', '9011001', '9011003'],
      ['MOBILE_CONFIRM', '9011001', '9011003'],
    ]);
    for (const l of logs) expect(l.at).toBeInstanceOf(Date);
  });

  it('never self-verification; a revoke stops the next action in the existing session', async () => {
    const self = await act(
      '9011001',
      ids['9011001'] ?? String((await User.findOne({ ajeerCode: '9011001' }).lean())!._id),
      'confirm-mobile',
    ).expect(403);
    expect(self.body.error.message).toMatch(/own mobile/);
    await pendingAdmin('9011004', '03031230004');
    await setPermission({
      ajeerCode: '9011001',
      permission: 'VERIFY_PAKISTAN_MOBILE',
      grant: false,
      actor: 'test',
    });
    await all3('9011001', ids['9011004']!, 403);
    const still = await login({
      ajeerCode: '9011004',
      password: INITIAL_PASSWORD,
      mobile: '03031230004',
    });
    expect(still.body.error.code).toBe('MOBILE_PENDING');
  });

  it('designations record the operator and the decision reference', async () => {
    await setPermission({
      ajeerCode: '9011001',
      permission: 'VERIFY_PAKISTAN_MOBILE',
      grant: true,
      actor: 'Central IT',
      reference: 'DES/2026/007',
    });
    const log = await AuditLog.findOne({
      action: 'USER_PERMISSION',
      'details.targetAjeerCode': '9011001',
      'details.granted': true,
    })
      .sort({ at: -1 })
      .lean();
    expect(log).toMatchObject({
      actorAjeerCode: 'Central IT',
      details: { permission: 'VERIFY_PAKISTAN_MOBILE', reference: 'DES/2026/007' },
    });
  });

  it('Central IT activates / deactivates a Pakistan Admin (audited); sessions stop at once', async () => {
    const status = (ajeerCode: string, isActive: boolean, reference = 'STS/2026/001') =>
      setPakistanAdminActive({ ajeerCode, isActive, operator: 'Central IT', reference });
    expect(await status('9020001', false)).toMatchObject({ ok: false, reason: 'NOT_CENTRAL' });
    expect(await status('9011002', false, '')).toMatchObject({ ok: false, reason: 'INVALID' });
    expect(await status('9019999', false)).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    await request(app).get('/api/v1/auth/me').set('Cookie', cookies['9011002']!).expect(200);
    expect(await status('9011002', false)).toEqual({ ok: true, changed: true });
    await request(app).get('/api/v1/auth/me').set('Cookie', cookies['9011002']!).expect(401);
    expect(await status('9011002', false)).toEqual({ ok: true, changed: false });
    expect(await status('9011002', true)).toEqual({ ok: true, changed: true });
    // Re-activation does not revive a session from before the deactivation.
    await request(app).get('/api/v1/auth/me').set('Cookie', cookies['9011002']!).expect(401);
    cookies['9011002'] = await loginCookie(app, '9011002');
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
    expect(await User.countDocuments({ ajeerCode: '9020001', isActive: true })).toBe(1);
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

    await login({ ajeerCode: '9090412', password: 'demo1234' }).expect(401);
    const res = await login({
      ajeerCode: '9090412',
      password: INITIAL_PASSWORD,
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

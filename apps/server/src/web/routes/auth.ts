import { hash, verify } from '@node-rs/argon2';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { randomInt } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticator } from 'otplib';
import { z } from 'zod';
import type { AuthSessionDTO, AuthStateDTO, PasskeyDTO } from '@ant/shared';
import { authChallenges, authSessions, owner, webauthnCredentials, type RecoveryCode } from '../../db/schema';
import { audit } from '../../lib/audit';
import { decrypt, encrypt, randomToken, safeEqual, sha256 } from '../../lib/crypto';
import { HttpError } from '../../lib/errors';
import type { WebDeps } from '../deps';
import {
  assertNotThrottled,
  clearSessionCookie,
  createSession,
  recordAttempt,
  requireStage,
  revokeSession,
  upgradeSession,
} from '../session';

authenticator.options = { window: 1 };

const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const CHALLENGE_COOKIE = 'ant_challenge';

const passwordSchema = z
  .string()
  .min(14, 'Le mot de passe doit contenir au moins 14 caractères.')
  .max(256)
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'Ce mot de passe est trop courant.')
  .refine((p) => new Set(p).size >= 6, 'Ce mot de passe est trop répétitif.');

/** Tiny deny-list; length ≥ 14 already excludes most of the classic lists. */
const COMMON_PASSWORDS = new Set([
  'motdepasse1234', 'password123456', 'azertyuiop1234', 'qwertyuiop1234', '12345678901234', 'iloveyou123456',
  'administrateur', 'administrator1', 'passwordpassword', 'motdepassemotdepasse', 'azertyazertyaz', '00000000000000',
]);

function generateRecoveryCodes(): { plain: string[]; stored: RecoveryCode[] } {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const plain = Array.from({ length: 10 }, () => {
    const chars = Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
  return { plain, stored: plain.map((c) => ({ hash: sha256(c), usedAt: null })) };
}

async function getOwner(deps: WebDeps) {
  return deps.ctx.db.query.owner.findFirst({ where: eq(owner.id, 1) });
}

async function storeChallenge(deps: WebDeps, reply: FastifyReply, challenge: string, purpose: 'register' | 'login'): Promise<void> {
  const [row] = await deps.ctx.db
    .insert(authChallenges)
    .values({ challenge, purpose, expiresAt: new Date(Date.now() + 5 * 60_000) })
    .returning();
  reply.setCookie(CHALLENGE_COOKIE, row!.id, { path: '/api/auth', httpOnly: true, secure: deps.session.secureCookies, sameSite: 'strict', maxAge: 300 });
}

async function takeChallenge(deps: WebDeps, req: FastifyRequest, reply: FastifyReply, purpose: 'register' | 'login'): Promise<string> {
  const id = req.cookies[CHALLENGE_COOKIE];
  reply.clearCookie(CHALLENGE_COOKIE, { path: '/api/auth' });
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'no_challenge', 'Défi WebAuthn introuvable : recommence.');
  const [row] = await deps.ctx.db
    .delete(authChallenges)
    .where(and(eq(authChallenges.id, id), eq(authChallenges.purpose, purpose), gt(authChallenges.expiresAt, new Date())))
    .returning();
  if (!row) throw new HttpError(400, 'no_challenge', 'Défi WebAuthn expiré : recommence.');
  return row.challenge;
}

export async function authRoutes(app: FastifyInstance, deps: WebDeps): Promise<void> {
  const { ctx, cfg } = deps;

  app.get('/api/auth/state', { config: { public: true } }, async (req): Promise<AuthStateDTO> => {
    const o = await getOwner(deps);
    const passkeys = await ctx.db.select({ id: webauthnCredentials.id }).from(webauthnCredentials).limit(1);
    return {
      setupRequired: !o || !o.totpEnabled,
      authenticated: req.session?.stage === 'full',
      secondFactorPending: req.session?.stage === 'mfa',
      enrolmentPending: req.session?.stage === 'enroll',
      hasPasskey: passkeys.length > 0,
    };
  });

  // ───────────── First-run setup ─────────────
  app.post('/api/auth/setup', { config: { public: true } }, async (req, reply) => {
    const body = z.object({ setupToken: z.string().min(1), password: z.string() }).parse(req.body);
    await assertNotThrottled(ctx, req.ip);
    const existing = await getOwner(deps);
    if (existing?.totpEnabled) throw new HttpError(409, 'already_setup', 'Ant est déjà configuré.');
    if (!deps.setupToken.value || !safeEqual(body.setupToken.trim(), deps.setupToken.value)) {
      await recordAttempt(ctx, req.ip, 'setup', false);
      throw new HttpError(403, 'invalid_setup_token', 'Jeton d’initialisation invalide (voir les journaux du conteneur web).');
    }
    const password = passwordSchema.parse(body.password);
    const passwordHash = await hash(password, ARGON);
    const secret = authenticator.generateSecret(20);
    const values = {
      passwordHash,
      totpSecretEnc: encrypt(secret, cfg.ENCRYPTION_KEY),
      totpEnabled: false,
      webauthnUserId: existing?.webauthnUserId ?? randomToken(32),
      updatedAt: new Date(),
    };
    await ctx.db.insert(owner).values({ id: 1, ...values }).onConflictDoUpdate({ target: owner.id, set: values });
    await recordAttempt(ctx, req.ip, 'setup', true);
    await createSession(ctx, deps.session, req, reply, 'enroll');
    await audit(ctx.db, { actor: 'owner', event: 'auth.setup.password', ip: req.ip });
    return { totpSecret: secret, totpUri: authenticator.keyuri('propriétaire', 'Ant', secret) };
  });

  app.post('/api/auth/setup/totp', { config: { stage: 'enroll' } }, async (req, reply) => {
    requireStage(req, 'enroll');
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/, 'Code à 6 chiffres attendu.') }).parse(req.body);
    const o = await getOwner(deps);
    if (!o?.totpSecretEnc) throw new HttpError(400, 'no_setup', 'Initialisation non commencée.');
    if (!authenticator.verify({ token: code, secret: decrypt(o.totpSecretEnc, cfg.ENCRYPTION_KEY) })) {
      await recordAttempt(ctx, req.ip, 'setup_totp', false);
      throw new HttpError(400, 'invalid_code', 'Code incorrect. Vérifie l’heure de ton téléphone et réessaie.');
    }
    const codes = generateRecoveryCodes();
    await ctx.db.update(owner).set({ totpEnabled: true, recoveryCodes: codes.stored, updatedAt: new Date() }).where(eq(owner.id, 1));
    deps.setupToken.value = null;
    await upgradeSession(ctx, deps.session, req, reply);
    await audit(ctx.db, { actor: 'owner', event: 'auth.setup.complete', ip: req.ip });
    return { recoveryCodes: codes.plain };
  });

  // ───────────── Password + second factor ─────────────
  app.post('/api/auth/login', { config: { public: true } }, async (req, reply) => {
    const { password } = z.object({ password: z.string().max(256) }).parse(req.body);
    await assertNotThrottled(ctx, req.ip);
    const o = await getOwner(deps);
    if (!o?.totpEnabled) throw new HttpError(409, 'setup_required', 'Ant n’est pas encore configuré.');
    const valid = await verify(o.passwordHash, password).catch(() => false);
    await recordAttempt(ctx, req.ip, 'password', valid);
    if (!valid) {
      await audit(ctx.db, { actor: 'anonyme', event: 'auth.login.failed', detail: { step: 'password' }, ip: req.ip, outcome: 'failed' });
      throw new HttpError(401, 'invalid_credentials', 'Mot de passe incorrect.');
    }
    await createSession(ctx, deps.session, req, reply, 'mfa');
    return { next: 'second_factor' };
  });

  app.post('/api/auth/login/second-factor', { config: { stage: 'mfa' } }, async (req, reply) => {
    requireStage(req, 'mfa');
    const body = z.object({ code: z.string().optional(), recoveryCode: z.string().optional() }).parse(req.body);
    await assertNotThrottled(ctx, req.ip);
    const o = await getOwner(deps);
    if (!o?.totpSecretEnc) throw new HttpError(409, 'setup_required', 'Ant n’est pas encore configuré.');
    let ok = false;
    let method = 'totp';
    if (body.code && /^\d{6}$/.test(body.code.trim())) {
      ok = authenticator.verify({ token: body.code.trim(), secret: decrypt(o.totpSecretEnc, cfg.ENCRYPTION_KEY) });
    } else if (body.recoveryCode) {
      method = 'recovery_code';
      const h = sha256(body.recoveryCode.trim().toLowerCase());
      const idx = o.recoveryCodes.findIndex((c) => c.usedAt === null && safeEqual(c.hash, h));
      if (idx >= 0) {
        ok = true;
        const codes = o.recoveryCodes.map((c, i) => (i === idx ? { ...c, usedAt: new Date().toISOString() } : c));
        await ctx.db.update(owner).set({ recoveryCodes: codes, updatedAt: new Date() }).where(eq(owner.id, 1));
      }
    }
    await recordAttempt(ctx, req.ip, method, ok);
    if (!ok) {
      await audit(ctx.db, { actor: 'anonyme', event: 'auth.login.failed', detail: { step: method }, ip: req.ip, outcome: 'failed' });
      throw new HttpError(401, 'invalid_code', 'Code incorrect.');
    }
    await upgradeSession(ctx, deps.session, req, reply);
    await audit(ctx.db, { actor: 'owner', event: 'auth.login', detail: { method }, ip: req.ip });
    return { ok: true };
  });

  // ───────────── Passkeys ─────────────
  app.post('/api/auth/passkey/login/options', { config: { public: true } }, async (req, reply) => {
    await assertNotThrottled(ctx, req.ip);
    const creds = await ctx.db.select().from(webauthnCredentials);
    if (creds.length === 0) throw new HttpError(400, 'no_passkey', 'Aucune passkey enregistrée.');
    const options = await generateAuthenticationOptions({
      rpID: deps.rpID,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports as AuthenticatorTransportFuture[] })),
    });
    await storeChallenge(deps, reply, options.challenge, 'login');
    return options;
  });

  app.post('/api/auth/passkey/login/verify', { config: { public: true } }, async (req, reply) => {
    const { response } = z.object({ response: z.record(z.string(), z.unknown()) }).parse(req.body);
    await assertNotThrottled(ctx, req.ip);
    const challenge = await takeChallenge(deps, req, reply, 'login');
    const resp = response as unknown as AuthenticationResponseJSON;
    const cred = await ctx.db.query.webauthnCredentials.findFirst({ where: eq(webauthnCredentials.credentialId, String(resp.id)) });
    if (!cred) {
      await recordAttempt(ctx, req.ip, 'passkey', false);
      throw new HttpError(401, 'unknown_passkey', 'Passkey inconnue.');
    }
    let verified = false;
    let newCounter = cred.counter;
    try {
      const result = await verifyAuthenticationResponse({
        response: resp,
        expectedChallenge: challenge,
        expectedOrigin: cfg.PUBLIC_ORIGIN,
        expectedRPID: deps.rpID,
        requireUserVerification: true,
        credential: {
          id: cred.credentialId,
          publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
          counter: cred.counter,
          transports: cred.transports as AuthenticatorTransportFuture[],
        },
      });
      verified = result.verified;
      newCounter = result.authenticationInfo.newCounter;
    } catch {
      verified = false;
    }
    await recordAttempt(ctx, req.ip, 'passkey', verified);
    if (!verified) {
      await audit(ctx.db, { actor: 'anonyme', event: 'auth.login.failed', detail: { step: 'passkey' }, ip: req.ip, outcome: 'failed' });
      throw new HttpError(401, 'passkey_failed', 'Échec de la vérification de la passkey.');
    }
    await ctx.db.update(webauthnCredentials).set({ counter: newCounter, lastUsedAt: new Date() }).where(eq(webauthnCredentials.id, cred.id));
    await createSession(ctx, deps.session, req, reply, 'full');
    await audit(ctx.db, { actor: 'owner', event: 'auth.login', detail: { method: 'passkey', name: cred.name }, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/auth/passkey/register/options', async (_req, reply) => {
    const o = await getOwner(deps);
    if (!o) throw new HttpError(409, 'setup_required', 'Ant n’est pas encore configuré.');
    const creds = await ctx.db.select().from(webauthnCredentials);
    const options = await generateRegistrationOptions({
      rpName: 'Ant',
      rpID: deps.rpID,
      userName: 'proprietaire',
      userDisplayName: 'Propriétaire d’Ant',
      userID: new Uint8Array(Buffer.from(o.webauthnUserId, 'base64url')),
      attestationType: 'none',
      excludeCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    await storeChallenge(deps, reply, options.challenge, 'register');
    return options;
  });

  app.post('/api/auth/passkey/register/verify', async (req, reply): Promise<PasskeyDTO> => {
    const body = z.object({ response: z.record(z.string(), z.unknown()), name: z.string().min(1).max(60) }).parse(req.body);
    const challenge = await takeChallenge(deps, req, reply, 'register');
    let result;
    try {
      result = await verifyRegistrationResponse({
        response: body.response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: cfg.PUBLIC_ORIGIN,
        expectedRPID: deps.rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      throw new HttpError(400, 'passkey_invalid', `Enregistrement refusé : ${(err as Error).message}`);
    }
    if (!result.verified) throw new HttpError(400, 'passkey_invalid', 'Enregistrement de la passkey refusé.');
    const info = result.registrationInfo;
    const [row] = await ctx.db
      .insert(webauthnCredentials)
      .values({
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        name: body.name.trim(),
      })
      .returning();
    await audit(ctx.db, { actor: 'owner', event: 'auth.passkey.add', detail: { name: body.name }, ip: req.ip });
    return { id: row!.id, name: row!.name, createdAt: row!.createdAt.toISOString(), lastUsedAt: null };
  });

  app.get('/api/auth/passkeys', async (): Promise<PasskeyDTO[]> => {
    const rows = await ctx.db.select().from(webauthnCredentials).orderBy(desc(webauthnCredentials.createdAt));
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null }));
  });

  app.delete<{ Params: { id: string } }>('/api/auth/passkeys/:id', async (req) => {
    await ctx.db.delete(webauthnCredentials).where(eq(webauthnCredentials.id, req.params.id));
    await audit(ctx.db, { actor: 'owner', event: 'auth.passkey.delete', detail: { id: req.params.id }, ip: req.ip });
    return { ok: true };
  });

  // ───────────── Sessions & credentials ─────────────
  app.post('/api/auth/logout', { config: { public: true } }, async (req, reply) => {
    if (req.session) await revokeSession(ctx, req.session.id);
    clearSessionCookie(deps.session, reply);
    if (req.session?.stage === 'full') await audit(ctx.db, { actor: 'owner', event: 'auth.logout', ip: req.ip });
    return { ok: true };
  });

  app.get('/api/auth/sessions', async (req): Promise<AuthSessionDTO[]> => {
    const rows = await ctx.db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.stage, 'full'), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, new Date())))
      .orderBy(desc(authSessions.lastSeenAt));
    return rows.map((r) => ({
      id: r.id.slice(0, 16),
      current: r.id === req.session?.id,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      ip: r.ip,
      userAgent: r.userAgent,
    }));
  });

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (req) => {
    const prefix = req.params.id.replace(/[^0-9a-f]/g, '');
    if (prefix.length !== 16) throw new HttpError(400, 'invalid_id', 'Identifiant de session invalide.');
    const rows = await ctx.db.select({ id: authSessions.id }).from(authSessions).where(isNull(authSessions.revokedAt));
    const target = rows.find((r) => r.id.startsWith(prefix));
    if (target) await revokeSession(ctx, target.id);
    await audit(ctx.db, { actor: 'owner', event: 'auth.session.revoke', ip: req.ip });
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const body = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    await assertNotThrottled(ctx, req.ip);
    const o = await getOwner(deps);
    if (!o || !(await verify(o.passwordHash, body.current).catch(() => false))) {
      await recordAttempt(ctx, req.ip, 'password_change', false);
      throw new HttpError(401, 'invalid_credentials', 'Mot de passe actuel incorrect.');
    }
    const next = passwordSchema.parse(body.next);
    await ctx.db.update(owner).set({ passwordHash: await hash(next, ARGON), updatedAt: new Date() }).where(eq(owner.id, 1));
    // Revoke every other session.
    const others = await ctx.db.select({ id: authSessions.id }).from(authSessions).where(isNull(authSessions.revokedAt));
    for (const s of others) if (s.id !== req.session?.id) await revokeSession(ctx, s.id);
    await audit(ctx.db, { actor: 'owner', event: 'auth.password.change', ip: req.ip });
    return { ok: true };
  });

  app.post('/api/auth/recovery-codes', async (req) => {
    const body = z.object({ password: z.string() }).parse(req.body);
    await assertNotThrottled(ctx, req.ip);
    const o = await getOwner(deps);
    if (!o || !(await verify(o.passwordHash, body.password).catch(() => false))) {
      await recordAttempt(ctx, req.ip, 'recovery_regen', false);
      throw new HttpError(401, 'invalid_credentials', 'Mot de passe incorrect.');
    }
    const codes = generateRecoveryCodes();
    await ctx.db.update(owner).set({ recoveryCodes: codes.stored, updatedAt: new Date() }).where(eq(owner.id, 1));
    await audit(ctx.db, { actor: 'owner', event: 'auth.recovery_codes.regenerate', ip: req.ip });
    return { recoveryCodes: codes.plain };
  });
}

export { generateRecoveryCodes, passwordSchema };

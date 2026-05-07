import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { BBIDService } from './bbid.js';
import { assert } from './errors.js';
import { id } from './ids.js';

const DEFAULT_SCOPES = ['auth:read', 'money:write', 'webhooks:write'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[1-9]\d{9,14}$/;

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function fromB64url(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function sign(secret, value) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = Buffer.from(hashPassword(password, salt).split(':')[1], 'hex');
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function normalizeIdentifier({ email, phone, identifier }) {
  const value = String(identifier ?? email ?? phone ?? '').trim();
  const compactPhone = value.replace(/[()\-\s.]/g, '');
  if (EMAIL_PATTERN.test(value.toLowerCase())) {
    return { kind: 'email', value: value.toLowerCase() };
  }
  if (PHONE_PATTERN.test(compactPhone)) {
    return { kind: 'phone', value: compactPhone.startsWith('+') ? compactPhone : `+${compactPhone}` };
  }
  return null;
}

export class AuthService {
  constructor({ secret = randomBytes(32).toString('hex'), now = () => new Date(), bbid = new BBIDService({ now }) } = {}) {
    this.secret = secret;
    this.now = now;
    this.bbid = bbid;
    this.users = new Map();
    this.usersByIdentifier = new Map();
  }

  register({ email, phone, identifier, password, scopes = DEFAULT_SCOPES }) {
    const normalized = normalizeIdentifier({ email, phone, identifier });
    assert(normalized, 400, 'invalid_identifier', 'A valid email address or phone number is required.');
    assert(String(password ?? '').length >= 12, 400, 'weak_password', 'Password must be at least 12 characters.');
    assert(!this.usersByIdentifier.has(normalized.value), 409, 'identifier_taken', 'Email or phone number is already registered.');

    const userId = id('user');
    const bbid = this.bbid.generate({ userId, username: normalized.value });
    const user = {
      id: userId,
      email: normalized.kind === 'email' ? normalized.value : null,
      phone: normalized.kind === 'phone' ? normalized.value : null,
      primaryIdentifier: normalized.value,
      identifierKind: normalized.kind,
      bbid: bbid.display,
      bbidRaw: bbid.braille,
      bbidSig: bbid.signature,
      bbidCreated: bbid.createdAt,
      bbidHapticPattern: bbid.hapticPattern,
      passwordHash: hashPassword(password),
      scopes: [...new Set(scopes)],
      createdAt: this.now().toISOString()
    };
    this.users.set(user.id, user);
    this.usersByIdentifier.set(user.primaryIdentifier, user.id);
    return this.publicUser(user);
  }

  login({ email, phone, identifier, password, ttlSeconds = 3600 }) {
    const normalized = normalizeIdentifier({ email, phone, identifier });
    assert(normalized, 401, 'invalid_credentials', 'Invalid identifier or password.');
    const userId = this.usersByIdentifier.get(normalized.value);
    assert(userId, 401, 'invalid_credentials', 'Invalid identifier or password.');

    const user = this.users.get(userId);
    assert(verifyPassword(String(password ?? ''), user.passwordHash), 401, 'invalid_credentials', 'Invalid identifier or password.');
    return {
      token: this.issueSession(user, ttlSeconds),
      user: this.publicUser(user)
    };
  }

  issueSession(user, ttlSeconds = 3600) {
    const payload = {
      sub: user.id,
      scopes: user.scopes,
      exp: Math.floor(this.now().getTime() / 1000) + ttlSeconds
    };
    const encoded = b64url(JSON.stringify(payload));
    return `${encoded}.${sign(this.secret, encoded)}`;
  }

  authenticate(token, requiredScopes = []) {
    const [encoded, signature] = String(token ?? '').split('.');
    assert(encoded && signature, 401, 'invalid_token', 'Session token is missing or malformed.');
    assert(sign(this.secret, encoded) === signature, 401, 'invalid_token', 'Session token signature is invalid.');

    const payload = JSON.parse(fromB64url(encoded));
    assert(payload.exp >= Math.floor(this.now().getTime() / 1000), 401, 'expired_token', 'Session token has expired.');
    const user = this.users.get(payload.sub);
    assert(user, 401, 'unknown_user', 'Session user does not exist.');

    for (const scope of requiredScopes) {
      assert(payload.scopes.includes(scope), 403, 'missing_scope', `Missing required scope: ${scope}.`);
    }
    return { user: this.publicUser(user), scopes: payload.scopes };
  }

  publicUser(user) {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      primaryIdentifier: user.primaryIdentifier,
      identifierKind: user.identifierKind,
      bbid: user.bbid,
      bbidRaw: user.bbidRaw,
      bbidSig: user.bbidSig,
      bbidCreated: user.bbidCreated,
      bbidHapticPattern: user.bbidHapticPattern,
      scopes: user.scopes,
      createdAt: user.createdAt
    };
  }
}

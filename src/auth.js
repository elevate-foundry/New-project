import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { BBIDService } from './bbid.js';
import { AppError, assert } from './errors.js';
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
    this.roles = new Map();
    this.initializeDefaultRoles();
  }

  initializeDefaultRoles() {
    // Admin role with full access
    this.defineRole('admin', {
      permissions: ['*'],
      admin: true,
      description: 'Full system access with all permissions'
    });

    // Operator role for operational tasks
    this.defineRole('operator', {
      permissions: ['tools:read', 'tools:exec', 'tools:help', 'auth:read', 'money:read'],
      description: 'Can execute tools and read system state'
    });

    // Auditor role for read-only access
    this.defineRole('auditor', {
      permissions: ['tools:read', 'auth:read', 'money:read', 'webhooks:read', 'audit:read'],
      description: 'Read-only access for auditing'
    });

    // User role with basic permissions
    this.defineRole('user', {
      permissions: ['auth:read'],
      description: 'Basic user with minimal permissions'
    });
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
      roles: user.roles ?? [],
      createdAt: user.createdAt
    };
  }

  checkPermissions(session, requiredPermissions, resourceContext = {}) {
    if (!session) {
      throw new AppError(401, 'unauthorized', 'Authentication required for permission check.');
    }

    const { user, scopes: sessionScopes } = session;
    const userRoles = user.roles ?? [];
    // Use scopes from session (JWT) if available, otherwise fall back to user object
    const userScopes = Array.isArray(sessionScopes) ? sessionScopes : (Array.isArray(user.scopes) ? user.scopes : []);

    // Check direct scopes
    const missingScopes = requiredPermissions.filter(perm => !userScopes.includes(perm));
    
    // Check role-based permissions
    const rolePermissions = this.getRolePermissions(userRoles);
    const missingFromRoles = missingScopes.filter(perm => !rolePermissions.includes(perm));

    if (missingFromRoles.length > 0) {
      throw new AppError(403, 'forbidden', `Missing required permissions: ${missingFromRoles.join(', ')}`);
    }

    // Check resource-level conditions if provided
    if (resourceContext && Object.keys(resourceContext).length > 0) {
      this.checkResourceConditions(user, requiredPermissions, resourceContext);
    }

    return true;
  }

  getRolePermissions(roles) {
    const permissions = new Set();
    for (const role of roles) {
      const roleDef = this.roles.get(role);
      if (roleDef) {
        (roleDef.permissions ?? []).forEach(perm => permissions.add(perm));
        // Include inherited permissions
        if (roleDef.inherits) {
          const inheritedPerms = this.getRolePermissions(roleDef.inherits);
          inheritedPerms.forEach(perm => permissions.add(perm));
        }
      }
    }
    return Array.from(permissions);
  }

  checkResourceConditions(user, permissions, context) {
    // Resource ownership check
    if (context.ownerId && context.ownerId !== user.id) {
      // Check if user has admin override permission
      const hasAdmin = user.scopes.includes('admin') || 
                      (user.roles ?? []).some(role => this.roles.get(role)?.admin);
      if (!hasAdmin) {
        throw new AppError(403, 'forbidden', 'Resource ownership required.');
      }
    }

    // Time-based restrictions
    if (context.timeRestricted) {
      const now = this.now();
      const hour = now.getHours();
      if (context.allowedHours && !context.allowedHours.includes(hour)) {
        throw new AppError(403, 'forbidden', 'Action not allowed at this time.');
      }
    }

    // IP-based restrictions (if context provides IP)
    if (context.allowedIps && context.clientIp) {
      if (!context.allowedIps.some(ip => this.matchIp(context.clientIp, ip))) {
        throw new AppError(403, 'forbidden', 'Action not allowed from this IP.');
      }
    }
  }

  matchIp(clientIp, pattern) {
    // Simple IP matching - can be enhanced with CIDR support
    return clientIp === pattern || pattern === '0.0.0.0/0';
  }

  assignRole(userId, roleName) {
    const user = this.users.get(userId);
    if (!user) {
      throw new AppError(404, 'user_not_found', 'User not found.');
    }
    if (!this.roles.has(roleName)) {
      throw new AppError(404, 'role_not_found', `Role '${roleName}' not found.`);
    }

    if (!user.roles) {
      user.roles = [];
    }
    if (!user.roles.includes(roleName)) {
      user.roles.push(roleName);
    }
    return this.publicUser(user);
  }

  removeRole(userId, roleName) {
    const user = this.users.get(userId);
    if (!user) {
      throw new AppError(404, 'user_not_found', 'User not found.');
    }

    if (user.roles) {
      user.roles = user.roles.filter(r => r !== roleName);
    }
    return this.publicUser(user);
  }

  defineRole(name, config) {
    const role = {
      name,
      permissions: config.permissions ?? [],
      inherits: config.inherits ?? [],
      admin: config.admin ?? false,
      description: config.description ?? '',
      createdAt: this.now().toISOString()
    };
    this.roles.set(name, role);
    return role;
  }
}

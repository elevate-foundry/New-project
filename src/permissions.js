import { AppError } from './errors.js';

/**
 * Permissioned Action Execution System (PAES)
 * 
 * A comprehensive permission management system that provides:
 * - Scope-based permissions
 * - Role-Based Access Control (RBAC)
 * - Resource-level permission checks
 * - Policy-based conditional permissions
 * - Permission inheritance and hierarchy
 * - Audit trail integration
 */

export class PermissionService {
  constructor({ auth, audit, logger = console } = {}) {
    this.auth = auth;
    this.audit = audit;
    this.logger = logger;
    this.policies = new Map();
    this.permissionCache = new Map();
    this.cacheTtlMs = 60000; // 1 minute cache
    this.initializeDefaultPolicies();
  }

  initializeDefaultPolicies() {
    // Wildcard policy - admin bypasses all checks
    this.registerPolicy('admin_bypass', {
      description: 'Admin users bypass all permission checks',
      condition: (context) => {
        return context.session?.user?.scopes?.includes('admin') ||
               context.session?.user?.roles?.some(role => this.auth.roles.get(role)?.admin);
      },
      effect: 'allow'
    });

    // Time-based policy for operations
    this.registerPolicy('business_hours_only', {
      description: 'Only allow operations during business hours (9 AM - 5 PM)',
      condition: (context) => {
        const hour = new Date().getHours();
        return hour >= 9 && hour < 17;
      },
      effect: 'deny'
    });

    // Resource ownership policy
    this.registerPolicy('resource_ownership', {
      description: 'Users can only access their own resources unless admin',
      condition: (context) => {
        if (!context.resourceContext?.ownerId) return true;
        if (context.session?.user?.id === context.resourceContext.ownerId) return true;
        return context.session?.user?.scopes?.includes('admin') ||
               context.session?.user?.roles?.some(role => this.auth.roles.get(role)?.admin);
      },
      effect: 'allow'
    });

    // Rate limiting policy
    this.registerPolicy('rate_limit', {
      description: 'Rate limit permission checks per user',
      condition: (context) => {
        const userId = context.session?.user?.id;
        if (!userId) return true;
        
        const now = Date.now();
        const windowMs = 60000; // 1 minute window
        const maxRequests = 100;
        
        const userKey = `rate:${userId}`;
        const userState = this.permissionCache.get(userKey) || { count: 0, resetAt: now + windowMs };
        
        if (now > userState.resetAt) {
          userState.count = 0;
          userState.resetAt = now + windowMs;
        }
        
        if (userState.count >= maxRequests) {
          this.logger.warn(`[PermissionService] Rate limit exceeded for user ${userId}`);
          return false;
        }
        
        userState.count++;
        this.permissionCache.set(userKey, userState);
        return true;
      },
      effect: 'deny'
    });
  }

  registerPolicy(name, config) {
    const policy = {
      name,
      description: config.description ?? '',
      condition: config.condition ?? (() => true),
      effect: config.effect ?? 'allow',
      priority: config.priority ?? 0,
      createdAt: new Date().toISOString()
    };
    this.policies.set(name, policy);
    this.logger.log(`[PermissionService] Registered policy: ${name}`);
    return policy;
  }

  async checkPermission({ session, requiredPermissions, resourceContext = {}, policyContext = {} }) {
    // If no session, deny immediately
    if (!session) {
      return { allowed: false, reason: 'No session provided' };
    }

    const cacheKey = this.getCacheKey(session?.user?.id, requiredPermissions, resourceContext);
    const cached = this.permissionCache.get(cacheKey);
    
    if (cached && Date.now() < cached.expiresAt) {
      return cached.result;
    }

    // Build context for policy evaluation
    const context = {
      session,
      requiredPermissions,
      resourceContext,
      policyContext,
      timestamp: new Date().toISOString()
    };

    // Evaluate all applicable policies
    const policyResults = [];
    for (const policy of this.policies.values()) {
      try {
        const applies = policy.condition(context);
        if (applies) {
          policyResults.push({
            name: policy.name,
            effect: policy.effect,
            priority: policy.priority
          });
        }
      } catch (error) {
        this.logger.error(`[PermissionService] Policy evaluation error for ${policy.name}:`, error.message);
      }
    }

    // Sort by priority (higher priority first)
    policyResults.sort((a, b) => b.priority - a.priority);

    // Check for explicit deny from high-priority policies
    const highPriorityDeny = policyResults.find(r => r.effect === 'deny' && r.priority >= 100);
    if (highPriorityDeny) {
      const result = { allowed: false, reason: `Policy denied: ${highPriorityDeny.name}` };
      this.cacheResult(cacheKey, result);
      return result;
    }

    // Check for explicit allow from high-priority policies
    const highPriorityAllow = policyResults.find(r => r.effect === 'allow' && r.priority >= 100);
    if (highPriorityAllow) {
      const result = { allowed: true, reason: `Policy allowed: ${highPriorityAllow.name}` };
      this.cacheResult(cacheKey, result);
      return result;
    }

    // Fall back to standard permission checking via AuthService
    try {
      this.auth.checkPermissions(session, requiredPermissions, resourceContext);
      const result = { allowed: true, reason: 'Permission check passed' };
      this.cacheResult(cacheKey, result);
      return result;
    } catch (error) {
      const result = { allowed: false, reason: error.message };
      this.cacheResult(cacheKey, result);
      return result;
    }
  }

  async checkToolPermission({ session, toolName, toolPermissions, resourceContext = {} }) {
    const result = await this.checkPermission({
      session,
      requiredPermissions: toolPermissions,
      resourceContext,
      policyContext: { toolName }
    });

    if (!result.allowed) {
      await this.audit?.append({
        type: 'permission.denied',
        actor: { userId: session?.user?.id, bbid: session?.user?.bbid },
        summary: `Tool ${toolName} permission denied: ${result.reason}`,
        metadata: {
          toolName,
          requiredPermissions: toolPermissions,
          resourceContext,
          reason: result.reason
        }
      });
    }

    return result;
  }

  async checkResourcePermission({ session, action, resourceType, resourceId, resourceContext = {} }) {
    const permission = `${resourceType}:${action}`;
    const result = await this.checkPermission({
      session,
      requiredPermissions: [permission],
      resourceContext: { ...resourceContext, resourceType, resourceId },
      policyContext: { action, resourceType, resourceId }
    });

    if (!result.allowed) {
      await this.audit?.append({
        type: 'permission.denied',
        actor: { userId: session?.user?.id, bbid: session?.user?.bbid },
        summary: `Resource permission denied: ${action} on ${resourceType}/${resourceId}`,
        metadata: {
          action,
          resourceType,
          resourceId,
          reason: result.reason
        }
      });
    }

    return result;
  }

  async grantPermission({ userId, permission, resourceContext = {} }) {
    const user = this.auth.users.get(userId);
    if (!user) {
      throw new AppError(404, 'user_not_found', 'User not found');
    }

    if (!Array.isArray(user.scopes)) {
      user.scopes = [];
    }

    if (!user.scopes.includes(permission)) {
      user.scopes.push(permission);
      await this.audit?.append({
        type: 'permission.granted',
        actor: { userId },
        summary: `Granted permission ${permission} to user ${userId}`,
        metadata: { permission, resourceContext }
      });
    }

    return this.auth.publicUser(user);
  }

  async revokePermission({ userId, permission }) {
    const user = this.auth.users.get(userId);
    if (!user) {
      throw new AppError(404, 'user_not_found', 'User not found');
    }

    if (Array.isArray(user.scopes)) {
      user.scopes = user.scopes.filter(p => p !== permission);
      await this.audit?.append({
        type: 'permission.revoked',
        actor: { userId },
        summary: `Revoked permission ${permission} from user ${userId}`,
        metadata: { permission }
      });
    }

    return this.auth.publicUser(user);
  }

  getEffectivePermissions(userId) {
    const user = this.auth.users.get(userId);
    if (!user) {
      throw new AppError(404, 'user_not_found', 'User not found');
    }

    const scopes = new Set(Array.isArray(user.scopes) ? user.scopes : []);
    const roles = Array.isArray(user.roles) ? user.roles : [];

    // Add role permissions
    for (const role of roles) {
      const rolePerms = this.auth.getRolePermissions([role]);
      rolePerms.forEach(perm => scopes.add(perm));
    }

    return {
      userId,
      scopes: Array.from(scopes),
      roles,
      isAdmin: scopes.has('admin') || roles.some(r => this.auth.roles.get(r)?.admin)
    };
  }

  listPolicies() {
    return Array.from(this.policies.values()).map(policy => ({
      name: policy.name,
      description: policy.description,
      effect: policy.effect,
      priority: policy.priority
    }));
  }

  getCacheKey(userId, permissions, resourceContext) {
    return `${userId}:${permissions.sort().join(',')}:${JSON.stringify(resourceContext)}`;
  }

  cacheResult(key, result) {
    this.permissionCache.set(key, {
      result,
      expiresAt: Date.now() + this.cacheTtlMs
    });
  }

  clearCache(userId) {
    for (const key of this.permissionCache.keys()) {
      if (key.startsWith(`${userId}:`)) {
        this.permissionCache.delete(key);
      }
    }
  }

  getPermissionStats() {
    return {
      totalPolicies: this.policies.size,
      cacheSize: this.permissionCache.size,
      cacheTtlMs: this.cacheTtlMs
    };
  }
}

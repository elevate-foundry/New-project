import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AuthService } from '../src/auth.js';
import { PermissionService } from '../src/permissions.js';
import { AuditService } from '../src/audit.js';

describe('Permissioned Action Execution System', () => {
  let auth;
  let permissions;
  let audit;

  it('should initialize AuthService with default roles', () => {
    auth = new AuthService();
    assert(auth.roles.has('admin'), 'Admin role should exist');
    assert(auth.roles.has('operator'), 'Operator role should exist');
    assert(auth.roles.has('auditor'), 'Auditor role should exist');
    assert(auth.roles.has('user'), 'User role should exist');
  });

  it('should register and login a user', () => {
    const user = auth.register({
      email: 'test@example.com',
      password: 'correct horse battery staple'
    });
    assert(user.email === 'test@example.com');
    assert(user.scopes.length > 0);

    const login = auth.login({
      email: 'test@example.com',
      password: 'correct horse battery staple'
    });
    assert(login.token);
    assert(login.user.id === user.id);
  });

  it('should register user with custom scopes', () => {
    const user = auth.register({
      email: 'custom@example.com',
      password: 'correct horse battery staple',
      scopes: ['tools:read', 'tools:exec']
    });
    assert(user.scopes.includes('tools:read'));
    assert(user.scopes.includes('tools:exec'));
  });

  it('should assign and remove roles from users', () => {
    const user = auth.register({
      email: 'operator@example.com',
      password: 'correct horse battery staple'
    });

    const withRole = auth.assignRole(user.id, 'operator');
    assert(withRole.roles.includes('operator'));

    const withoutRole = auth.removeRole(user.id, 'operator');
    assert(!withoutRole.roles.includes('operator'));
  });

  it('should check permissions via direct scopes', () => {
    const user = auth.register({
      email: 'scoped@example.com',
      password: 'correct horse battery staple',
      scopes: ['tools:read', 'tools:exec']
    });
    const login = auth.login({
      email: 'scoped@example.com',
      password: 'correct horse battery staple'
    });

    // Should pass with direct scopes
    auth.checkPermissions(login, ['tools:read']);
    auth.checkPermissions(login, ['tools:exec']);

    // Should fail with missing scope
    assert.throws(() => {
      auth.checkPermissions(login, ['admin']);
    }, /Missing required permissions/);
  });

  it('should check permissions via roles', () => {
    const user = auth.register({
      email: 'roleuser@example.com',
      password: 'correct horse battery staple',
      scopes: []
    });
    auth.assignRole(user.id, 'operator');
    const login = auth.login({
      email: 'roleuser@example.com',
      password: 'correct horse battery staple'
    });

    // Should pass via role permissions
    auth.checkPermissions(login, ['tools:read']);
    auth.checkPermissions(login, ['tools:exec']);

    // Should fail with permission not in role
    assert.throws(() => {
      auth.checkPermissions(login, ['money:write']);
    }, /Missing required permissions/);
  });

  it('should respect role inheritance', () => {
    auth.defineRole('senior_operator', {
      permissions: ['money:write'],
      inherits: ['operator']
    });

    const user = auth.register({
      email: 'senior@example.com',
      password: 'correct horse battery staple',
      scopes: []
    });
    auth.assignRole(user.id, 'senior_operator');
    const login = auth.login({
      email: 'senior@example.com',
      password: 'correct horse battery staple'
    });

    // Should have both inherited and direct permissions
    auth.checkPermissions(login, ['tools:read']); // inherited from operator
    auth.checkPermissions(login, ['money:write']); // direct from senior_operator
  });

  it('should enforce resource ownership', () => {
    const user = auth.register({
      email: 'owner@example.com',
      password: 'correct horse battery staple',
      scopes: ['tools:read']
    });
    const login = auth.login({
      email: 'owner@example.com',
      password: 'correct horse battery staple'
    });

    // Should allow access to own resources
    auth.checkPermissions(login, ['tools:read'], {
      ownerId: user.id
    });

    // Should deny access to others' resources
    assert.throws(() => {
      auth.checkPermissions(login, ['tools:read'], {
        ownerId: 'other-user-id'
      });
    }, /Resource ownership required/);
  });

  it('should allow admin to bypass ownership checks', () => {
    const user = auth.register({
      email: 'adminuser@example.com',
      password: 'correct horse battery staple',
      scopes: ['admin', 'tools:read']
    });
    const login = auth.login({
      email: 'adminuser@example.com',
      password: 'correct horse battery staple'
    });

    // Admin should access any resource
    auth.checkPermissions(login, ['tools:read'], {
      ownerId: 'other-user-id'
    });
  });

  it('should initialize PermissionService with default policies', () => {
    audit = new AuditService();
    permissions = new PermissionService({ auth, audit });
    
    const policies = permissions.listPolicies();
    assert(policies.some(p => p.name === 'admin_bypass'));
    assert(policies.some(p => p.name === 'business_hours_only'));
    assert(policies.some(p => p.name === 'resource_ownership'));
    assert(policies.some(p => p.name === 'rate_limit'));
  });

  it('should check tool permissions via PermissionService', async () => {
    const user = auth.register({
      email: 'tooluser@example.com',
      password: 'correct horse battery staple',
      scopes: ['tools:exec']
    });
    const login = auth.login({
      email: 'tooluser@example.com',
      password: 'correct horse battery staple'
    });

    const result = await permissions.checkToolPermission({
      session: login,
      toolName: 'exec',
      toolPermissions: ['tools:exec']
    });
    assert(result.allowed === true, `Expected permission to be allowed, got: ${JSON.stringify(result)}`);
  });

  it('should deny tool permissions when missing', async () => {
    const user = auth.register({
      email: 'noperms@example.com',
      password: 'correct horse battery staple',
      scopes: []
    });
    const login = auth.login({
      email: 'noperms@example.com',
      password: 'correct horse battery staple'
    });

    const result = await permissions.checkToolPermission({
      session: login,
      toolName: 'exec',
      toolPermissions: ['tools:exec']
    });
    assert(result.allowed === false);
  });

  it('should check resource permissions', async () => {
    const user = auth.register({
      email: 'resourceuser@example.com',
      password: 'correct horse battery staple',
      scopes: ['account:read']
    });
    const login = auth.login({
      email: 'resourceuser@example.com',
      password: 'correct horse battery staple'
    });

    const result = await permissions.checkResourcePermission({
      session: login,
      action: 'read',
      resourceType: 'account',
      resourceId: 'acct-123',
      resourceContext: { ownerId: user.id }
    });
    assert(result.allowed === true, `Expected permission to be allowed, got: ${JSON.stringify(result)}`);
  });

  it('should get effective permissions for a user', () => {
    const user = auth.register({
      email: 'effective@example.com',
      password: 'correct horse battery staple',
      scopes: ['auth:read']
    });
    auth.assignRole(user.id, 'operator');

    const effective = permissions.getEffectivePermissions(user.id);
    assert(effective.userId === user.id);
    assert(effective.roles.includes('operator'));
    assert(effective.scopes.includes('auth:read'));
    assert(effective.scopes.includes('tools:read')); // from role
  });

  it('should grant and revoke permissions', async () => {
    const user = auth.register({
      email: 'grantuser@example.com',
      password: 'correct horse battery staple',
      scopes: ['auth:read']
    });

    const granted = await permissions.grantPermission({
      userId: user.id,
      permission: 'tools:read'
    });
    assert(granted.scopes.includes('tools:read'));

    const revoked = await permissions.revokePermission({
      userId: user.id,
      permission: 'tools:read'
    });
    assert(!revoked.scopes.includes('tools:read'));
  });

  it('should register custom policies', () => {
    const policy = permissions.registerPolicy('custom_policy', {
      description: 'A custom test policy',
      condition: () => true,
      effect: 'allow',
      priority: 50
    });
    assert(policy.name === 'custom_policy');
    assert(policy.priority === 50);
  });

  it('should return permission stats', () => {
    const stats = permissions.getPermissionStats();
    assert(stats.totalPolicies > 0);
    assert(typeof stats.cacheSize === 'number');
    assert(stats.cacheTtlMs === 60000);
  });

  it('should clear permission cache for a user', () => {
    const user = auth.register({
      email: 'cacheuser@example.com',
      password: 'correct horse battery staple',
      scopes: ['tools:read']
    });
    
    permissions.clearCache(user.id);
    // Should not throw
  });
});

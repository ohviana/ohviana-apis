import { describe, expect, it } from 'vitest';
import { ORG_PERMISSIONS, roleHasPermission, statusAllowsPermission } from './permissions';

describe('role permissions', () => {
  it('gives owners and co-owners everything', () => {
    for (const p of ORG_PERMISSIONS) {
      expect(roleHasPermission('owner', p)).toBe(true);
      expect(roleHasPermission('co_owner', p)).toBe(true);
    }
  });

  it('limits trek leads to reading batches and attendees', () => {
    expect(roleHasPermission('trek_lead', 'batches:read')).toBe(true);
    expect(roleHasPermission('trek_lead', 'attendees:read')).toBe(true);
    for (const p of ['org:read', 'bookings:read', 'batches:write', 'org:manage_members'] as const) {
      expect(roleHasPermission('trek_lead', p)).toBe(false);
    }
  });
});

describe('status permissions', () => {
  it('lets pending organizers prepare drafts but not share links or manage bookings', () => {
    expect(statusAllowsPermission('pending', 'treks:write')).toBe(true);
    expect(statusAllowsPermission('pending', 'links:write')).toBe(false);
    expect(statusAllowsPermission('pending', 'batches:publish')).toBe(false);
    expect(statusAllowsPermission('pending', 'bookings:manage')).toBe(false);
  });

  it('makes suspended organizers read-only', () => {
    expect(statusAllowsPermission('suspended', 'bookings:read')).toBe(true);
    expect(statusAllowsPermission('suspended', 'batches:write')).toBe(false);
  });
});

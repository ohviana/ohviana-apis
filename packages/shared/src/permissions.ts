import type { OrganizerRole, OrganizerStatus } from './domain';

/** Everything a member of an organizer can do. Routes declare one; roles grant a set. */
export const ORG_PERMISSIONS = [
  'org:read',
  'org:edit_profile',
  'org:manage_members',
  'treks:write',
  'batches:write',
  /** Making a batch bookable. Requires an approved organizer. */
  'batches:publish',
  'links:write',
  'bookings:read',
  'bookings:manage',
  /** A batch's details. Trek leads get it only for batches they lead. */
  'batches:read',
  /** A batch's attendee list and CSV. Trek leads get it only for batches they lead. */
  'attendees:read',
] as const;
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<OrganizerRole, readonly OrgPermission[]> = {
  owner: ORG_PERMISSIONS,
  co_owner: ORG_PERMISSIONS,
  // Scoped further to the batches whose leads list their mobile (see the organizer guard).
  trek_lead: ['batches:read', 'attendees:read'],
};

/** Permissions still allowed while an organizer is not approved. */
const LIMITED_STATUS_PERMISSIONS: Record<
  Exclude<OrganizerStatus, 'approved'>,
  readonly OrgPermission[]
> = {
  // Pending organizers can prepare their profile and drafts before approval.
  pending: [
    'org:read',
    'org:edit_profile',
    'org:manage_members',
    'treks:write',
    'batches:write',
    'batches:read',
  ],
  // Rejected/suspended organizers keep read access to their own records only.
  rejected: ['org:read', 'bookings:read', 'batches:read', 'attendees:read'],
  suspended: ['org:read', 'bookings:read', 'batches:read', 'attendees:read'],
};

export function roleHasPermission(role: OrganizerRole, permission: OrgPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function statusAllowsPermission(
  status: OrganizerStatus,
  permission: OrgPermission,
): boolean {
  return status === 'approved' || LIMITED_STATUS_PERMISSIONS[status].includes(permission);
}

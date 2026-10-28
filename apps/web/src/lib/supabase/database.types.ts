// migrations-sha256: 7d9d60a232c2300506b732d927c58efee78cc167ce94ac2cde8bf1816ad547dc
/* Generated from 7 migrations. Run `npm run db:types` after changing the schema. */
/* Generated from 5 migrations. Run `npm run db:types` after changing the schema. */

/**
 * Schema types for RLS-filtered reads (Phase 0 subset).
 *
 * Regenerate with the Supabase CLI (`npm run db:types`) once the local stack is running; the
 * stamp on line 1 is verified in CI so these can never silently drift from `supabase/migrations`.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected';
export type PlanCode = 'basic' | 'pro' | 'business';
export type OrgKind = 'company' | 'agency';
export type MemberRole = 'owner' | 'manager' | 'accountant' | 'dispatcher';
export type MemberStatus = 'invited' | 'active' | 'suspended' | 'removed';
export type VerificationSubject = 'individual' | 'organization';
export type VerificationRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';
export type VerificationOutcome = 'approve' | 'reject';
export type NotificationKind =
  | 'verification_submitted'
  | 'verification_approved'
  | 'verification_rejected'
  | 'verification_invalidated'
  | 'member_invited'
  | 'member_joined'
  | 'member_removed'
  | 'role_granted'
  | 'role_revoked';

export type PlatformRole =
  'platform_admin' | 'platform_staff' | 'finance_officer' | 'geo_supervisor';

export interface Profile {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  phone_verified_at: string | null;
  preferred_language: 'ar' | 'en';
  preferred_numerals: 'western' | 'arabic_indic';
  verification_status: VerificationStatus;
  national_id_type: 'national_id' | 'passport' | 'residence' | null;
  national_id_number: string | null;
  birth_place: string | null;
  date_of_birth: string | null;
  avatar_path: string | null;
  verification_note: string | null;
  onboarded_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Organization {
  id: string;
  kind: OrgKind;
  name: string;
  name_en: string | null;
  registration_no: string | null;
  tax_no: string | null;
  phone: string | null;
  email: string | null;
  logo_path: string | null;
  owner_id: string;
  verification_status: VerificationStatus;
  plan: PlanCode;
  created_at: string;
  updated_at: string;
}

export interface OrganizationMember {
  id: string;
  org_id: string;
  user_id: string | null;
  role: MemberRole;
  status: MemberStatus;
  invited_by: string | null;
  invited_email: string | null;
  invited_phone: string | null;
  invite_token_hash: string | null;
  invite_expires_at: string | null;
  joined_at: string | null;
  removed_at: string | null;
  removed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface VerificationRequest {
  id: string;
  subject_type: VerificationSubject;
  subject_id: string;
  requested_by: string;
  status: VerificationRequestStatus;
  note: string | null;
  snapshot: Json;
  decision_by: string | null;
  decision_at: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface VerificationDocument {
  id: string;
  request_id: string;
  kind: string;
  storage_path: string;
  mime: string | null;
  size_bytes: number | null;
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  kind: NotificationKind;
  title_key: string;
  params: Json;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export interface UserRole {
  id: string;
  user_id: string;
  role: PlatformRole;
  granted_by: string | null;
  granted_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  reason: string | null;
}

export interface AuditLogRow {
  id: number;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Json | null;
  after: Json | null;
  reason: string | null;
  request_id: string | null;
  ip: string | null;
  outcome: 'success' | 'denied' | 'failed';
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Partial<Profile> & { id: string };
        Update: Partial<Profile>;
      };
      user_roles: {
        Row: UserRole;
        Insert: Partial<UserRole> & { user_id: string; role: PlatformRole };
        Update: Partial<UserRole>;
      };
      organizations: {
        Row: Organization;
        Insert: Partial<Organization> & { name: string; owner_id: string };
        Update: Partial<Organization>;
      };
      organization_members: {
        Row: OrganizationMember;
        Insert: Partial<OrganizationMember> & { org_id: string; role: MemberRole };
        Update: Partial<OrganizationMember>;
      };
      verification_requests: {
        Row: VerificationRequest;
        Insert: Partial<VerificationRequest> & {
          subject_type: VerificationSubject;
          subject_id: string;
          requested_by: string;
        };
        Update: Partial<VerificationRequest>;
      };
      verification_documents: {
        Row: VerificationDocument;
        Insert: Partial<VerificationDocument> & {
          request_id: string;
          kind: string;
          storage_path: string;
        };
        Update: Partial<VerificationDocument>;
      };
      notifications: {
        Row: Notification;
        Insert: Partial<Notification> & {
          user_id: string;
          kind: NotificationKind;
          title_key: string;
        };
        Update: Partial<Notification>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      verification_status: VerificationStatus;
      platform_role: PlatformRole;
      plan_code: PlanCode;
      org_kind: OrgKind;
      member_role: MemberRole;
      member_status: MemberStatus;
      verification_subject: VerificationSubject;
      verification_request_status: VerificationRequestStatus;
      verification_outcome: VerificationOutcome;
      notification_kind: NotificationKind;
    };
  };
}

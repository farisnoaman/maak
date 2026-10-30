// migrations-sha256: a47c7682f74f5dc6acfe535cfa31f42f6edd613afa55ead154aadc738dccd9b5
/* Generated from 11 migrations. Run `npm run db:types` after changing the schema. */

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
export type RegionKind = 'region' | 'sub_region';
export type PlaceKind =
  | 'city'
  | 'town'
  | 'village'
  | 'district_centre'
  | 'landmark'
  | 'station'
  | 'airport'
  | 'port'
  | 'border_crossing'
  | 'market'
  | 'hospital'
  | 'gathering_point'
  | 'other';

export interface Governorate {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  name_ar_norm: string;
  name_en_norm: string;
  region_hint: string | null;
  center_lat: number | null;
  center_lng: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface District {
  id: string;
  governorate_id: string;
  pcode: string | null;
  name_ar: string;
  name_en: string;
  name_ar_norm: string;
  name_en_norm: string;
  center_lat: number | null;
  center_lng: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Place {
  id: string;
  kind: PlaceKind;
  name_ar: string;
  name_en: string | null;
  name_ar_norm: string;
  name_en_norm: string;
  aliases_ar: string[];
  aliases_en: string[];
  aliases_norm: string;
  governorate_id: string | null;
  district_id: string | null;
  lat: number | null;
  lng: number | null;
  is_public: boolean;
  created_by: string | null;
  created_by_org: string | null;
  verification_status: VerificationStatus;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Region {
  id: string;
  parent_id: string | null;
  kind: RegionKind;
  name_ar: string;
  name_en: string;
  name_ar_norm: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RegionGovernorate {
  region_id: string;
  governorate_id: string;
}

export interface RegionDistrict {
  region_id: string;
  district_id: string;
}

export interface GeoAssignment {
  id: string;
  user_id: string;
  region_id: string;
  granted_by: string | null;
  granted_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  reason: string | null;
}

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
  deletion_requested_at: string | null;
  deletion_reason: string | null;
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
      governorates: {
        Row: Governorate;
        Insert: Partial<Governorate> & { code: string; name_ar: string; name_en: string };
        Update: Partial<Governorate>;
      };
      districts: {
        Row: District;
        Insert: Partial<District> & { governorate_id: string; name_ar: string; name_en: string };
        Update: Partial<District>;
      };
      places: {
        Row: Place;
        Insert: Partial<Place> & { kind: PlaceKind; name_ar: string };
        Update: Partial<Place>;
      };
      regions: {
        Row: Region;
        Insert: Partial<Region> & { name_ar: string; name_en: string };
        Update: Partial<Region>;
      };
      region_governorates: {
        Row: RegionGovernorate;
        Insert: RegionGovernorate;
        Update: Partial<RegionGovernorate>;
      };
      region_districts: {
        Row: RegionDistrict;
        Insert: RegionDistrict;
        Update: Partial<RegionDistrict>;
      };
      geo_assignments: {
        Row: GeoAssignment;
        Insert: Partial<GeoAssignment> & { user_id: string; region_id: string };
        Update: Partial<GeoAssignment>;
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
      region_kind: RegionKind;
    };
  };
}

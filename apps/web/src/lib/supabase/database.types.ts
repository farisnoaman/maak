// migrations-sha256: 0d4c4356465a6e8b6dc9dc490a75826e66734b98b2cca4843d0739bd5ae95d7b
/* Generated from 5 migrations. Run `npm run db:types` after changing the schema. */

/**
 * Schema types for RLS-filtered reads (Phase 0 subset).
 *
 * Regenerate with the Supabase CLI (`npm run db:types`) once the local stack is running; the
 * stamp on line 1 is verified in CI so these can never silently drift from `supabase/migrations`.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected';

export type PlatformRole =
  'platform_admin' | 'platform_staff' | 'finance_officer' | 'geo_supervisor';

export interface Profile {
  id: string;
  full_name: string | null;
  phone: string | null;
  phone_verified_at: string | null;
  preferred_language: 'ar' | 'en';
  preferred_numerals: 'western' | 'arabic_indic';
  verification_status: VerificationStatus;
  created_at: string;
  updated_at: string;
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
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      verification_status: VerificationStatus;
      platform_role: PlatformRole;
    };
  };
}

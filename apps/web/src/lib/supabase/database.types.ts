// migrations-sha256: aab58d81251b78fd5323a4e58b8f6300b79079426453697179f029559004b434
/* Generated from 45 migrations. Run `npm run db:types` after changing the schema. */

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
export type VehicleBodyType =
  | 'sedan'
  | 'hatchback'
  | 'suv'
  | 'pickup'
  | 'van'
  | 'minibus'
  | 'bus'
  | 'coach'
  | 'truck'
  | 'other';
export type DriveType =
  'front_wheel_drive' | 'rear_wheel_drive' | 'four_wheel_drive' | 'all_wheel_drive';
export type Transmission = 'manual' | 'automatic' | 'cvt' | 'dual_clutch';
export type FuelType = 'petrol' | 'diesel' | 'hybrid' | 'electric' | 'lpg';
export type VehicleCondition = 'new' | 'used' | 'refurbished';
export type VehicleConditionRating = 'excellent' | 'good' | 'fair' | 'poor';
export type VehicleOwnershipKind = 'owned' | 'leased' | 'financed';
export type VehicleStatus = 'draft' | 'active' | 'suspended' | 'retired';
export type DriverStatus = 'invited' | 'active' | 'suspended' | 'revoked';
export type OdometerKind = 'baseline' | 'trip_start' | 'trip_end' | 'service';

export type MaintenanceKind =
  | 'oil_change'
  | 'oil_filter'
  | 'air_filter'
  | 'fuel_filter'
  | 'cabin_filter'
  | 'tyres'
  | 'brakes'
  | 'battery'
  | 'timing_belt'
  | 'coolant'
  | 'transmission'
  | 'suspension'
  | 'electrical'
  | 'bodywork'
  | 'inspection'
  | 'other';

export type MaintenanceState = 'ok' | 'due_soon' | 'overdue';

export type ExpenseCategory =
  | 'fuel'
  | 'maintenance'
  | 'insurance'
  | 'registration'
  | 'permit'
  | 'salary'
  | 'toll'
  | 'parking'
  | 'fine'
  | 'other';

export type ExpenseSource = 'fuel_log' | 'maintenance_record' | 'manual';

export type BookingStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'cancelled_by_passenger'
  | 'cancelled_by_operator'
  | 'no_show'
  | 'completed';
export type IdDocumentType = 'national_id' | 'passport' | 'iqama' | 'other';
export type BookingPaymentStatus = 'unpaid' | 'deposit_paid' | 'paid' | 'refunded';
export type BookingEventKind =
  | 'created'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'no_show'
  | 'completed'
  | 'document_shared';
export type DocumentAccessKind = 'owner' | 'operator' | 'staff' | 'share_link';

export type TripStatus =
  'draft' | 'pending' | 'published' | 'in_progress' | 'cancelled' | 'completed';
export type TripEventKind =
  | 'created'
  | 'updated'
  | 'stops_changed'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'published'
  | 'unpublished'
  | 'cancelled'
  | 'completed'
  | 'started'
  | 'stop_reached'
  | 'ended';
export type TripBookingMode = 'per_seat' | 'whole_trip' | 'both';
export type TripPricingMode = 'flat' | 'per_stop';
export type TripDiscountKind = 'none' | 'fixed' | 'percent';
export type TripDiscountScope = 'per_seat' | 'whole_trip' | 'all';
export type TripGenderPolicy = 'any' | 'women_only' | 'men_only';
export type TripPaymentPolicy = 'cash' | 'transfer' | 'deposit';
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
  | 'role_revoked'
  | 'booking_requested'
  | 'booking_accepted'
  | 'booking_rejected'
  | 'booking_cancelled'
  | 'vehicle_maintenance_due'
  | 'vehicle_maintenance_overdue'
  | 'vehicle_fuel_anomaly'
  | 'payment_submitted'
  | 'payment_confirmed'
  | 'payment_rejected'
  | 'refund_decided'
  | 'payout_decided'
  | 'invoice_issued'
  | 'subscription_activated'
  | 'subscription_past_due'
  | 'subscription_expired'
  | 'finance_alert'
  | 'saved_search_match'
  | 'trip_reminder'
  | 'quota_threshold'
  | 'subscription_expiring'
  | 'verification_sla';

/** Phase 11. `critical` is the only value that bypasses quiet hours. */
export type NotificationPriority = 'critical' | 'normal' | 'low';

export type NotificationChannel = 'in_app' | 'push' | 'email' | 'whatsapp';

export type NotificationDeliveryStatus =
  'pending' | 'sending' | 'sent' | 'skipped' | 'failed' | 'dead';

export type PlatformRole =
  'platform_admin' | 'platform_staff' | 'finance_officer' | 'geo_supervisor';

export type LedgerAccountKind = 'asset' | 'liability' | 'revenue' | 'expense' | 'equity';
export type JournalSourceKind =
  | 'payment'
  | 'refund'
  | 'payout'
  | 'invoice'
  | 'commission'
  | 'subscription'
  | 'expense'
  | 'adjustment';
export type InvoiceKind = 'booking' | 'subscription';
export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void' | 'overdue';
export type SubscriptionStatus =
  'trialing' | 'active' | 'past_due' | 'grace' | 'cancelled' | 'expired';
export type SubscriptionEventKind =
  | 'started'
  | 'trial_ended'
  | 'renewed'
  | 'plan_changed'
  | 'cancelled'
  | 'expired'
  | 'payment_failed';
export type ReconciliationStatus = 'pending' | 'matched' | 'exception' | 'ignored';

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
  /** Set by cmd_delete_account (00039): every identifying column is null by then. */
  deleted_at: string | null;
  deleted_by: string | null;
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
  priority: NotificationPriority;
  /** Idempotency for a scheduled event. Null on a one-off. */
  dedupe_key: string | null;
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

export interface Plan {
  code: PlanCode;
  name_ar: string;
  name_en: string;
  price_yer: number;
  trial_days: number;
  soft_limit: boolean;
  features: Json;
  updated_at: string;
}

export interface PlanLimit {
  plan_code: PlanCode;
  metric: 'vehicles' | 'trips' | 'staff' | 'drivers' | 'active_trips' | 'featured_listings';
  limit_value: number | null;
}

export interface Vehicle {
  id: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  make: string;
  model: string;
  model_year: number;
  trim: string | null;
  plate_number: string;
  plate_norm: string;
  plate_governorate_id: string | null;
  vin: string | null;
  chassis_no: string | null;
  color: string | null;
  body_type: VehicleBodyType;
  drive_type: DriveType | null;
  transmission: Transmission | null;
  fuel_type: FuelType;
  engine_cc: number | null;
  cylinders: number | null;
  fuel_tank_l: number | null;
  tyre_size: string | null;
  tyre_count: number | null;
  spare_tyre: boolean;
  vehicle_condition: VehicleCondition;
  ownership_kind: VehicleOwnershipKind;
  seats_passenger: number;
  seats_total: number;
  luggage_capacity_l: number | null;
  roof_rack: boolean;
  air_conditioning: boolean;
  heating: boolean;
  reclining_seats: boolean;
  usb_charging: boolean;
  wifi: boolean;
  entertainment: boolean;
  curtains: boolean;
  reading_lights: boolean;
  airbags: number;
  abs: boolean;
  esp: boolean;
  seatbelts_all: boolean;
  fire_extinguisher: boolean;
  first_aid: boolean;
  emergency_exit: boolean;
  gps_device: boolean;
  speed_limiter: boolean;
  child_seat: boolean;
  wheelchair_accessible: boolean;
  step_assist: boolean;
  insurance_company: string | null;
  insurance_policy_no: string | null;
  insurance_expiry: string | null;
  inspection_expiry: string | null;
  registration_expiry: string | null;
  transport_permit_expiry: string | null;
  exterior_condition: VehicleConditionRating;
  interior_condition: VehicleConditionRating;
  odometer_km: number;
  status: VehicleStatus;
  verification_status: VerificationStatus;
  verified_by: string | null;
  verified_at: string | null;
  verification_note: string | null;
  is_active: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface VehiclePhoto {
  id: string;
  vehicle_id: string;
  storage_path: string;
  caption: string | null;
  is_primary: boolean;
  sort_order: number;
  uploaded_by: string | null;
  created_at: string;
}

export interface VehicleDocument {
  id: string;
  vehicle_id: string;
  kind: 'insurance' | 'registration' | 'inspection' | 'permit' | 'other';
  storage_path: string;
  mime: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  created_at: string;
}

export interface DriverProfile {
  id: string;
  user_id: string | null;
  invited_phone: string;
  full_name: string;
  org_id: string | null;
  invited_by: string | null;
  licence_no: string | null;
  licence_class: string | null;
  licence_expiry: string | null;
  licence_photo_path: string | null;
  status: DriverStatus;
  verification_status: VerificationStatus;
  verified_by: string | null;
  verified_at: string | null;
  verification_note: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface VehicleDriverAssignment {
  id: string;
  vehicle_id: string;
  driver_id: string;
  assigned_by: string | null;
  assigned_at: string;
  unassigned_at: string | null;
  unassigned_by: string | null;
  note: string | null;
}

export interface OdometerReading {
  id: string;
  vehicle_id: string;
  reading_km: number;
  kind: OdometerKind;
  driver_id: string | null;
  recorded_by: string | null;
  recorded_at: string;
  note: string | null;
  /** The trip this reading belongs to (`trip_start` / `trip_end`), from migration 00022. */
  trip_id: string | null;
}

/** Money is integer minor units (fils) throughout, including `total_cost_yer`. */
export interface FuelLog {
  id: string;
  vehicle_id: string;
  trip_id: string | null;
  driver_id: string | null;
  filled_at: string;
  odometer_km: number;
  litres: number;
  price_per_litre_yer: number;
  total_cost_yer: number;
  is_full_tank: boolean;
  station_name: string | null;
  station_place_id: string | null;
  receipt_path: string | null;
  note: string | null;
  recorded_by: string | null;
  created_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface MaintenanceSchedule {
  id: string;
  vehicle_id: string;
  kind: MaintenanceKind;
  interval_km: number | null;
  interval_days: number | null;
  last_done_km: number | null;
  last_done_on: string | null;
  /** Generated: `last_done_km + interval_km`. */
  due_km: number | null;
  /** Generated: `last_done_on + interval_days`. */
  due_on: string | null;
  is_active: boolean;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface MaintenanceRecord {
  id: string;
  vehicle_id: string;
  schedule_id: string | null;
  kind: MaintenanceKind;
  performed_on: string;
  odometer_km: number | null;
  cost_yer: number;
  vendor: string | null;
  note: string | null;
  attachment_path: string | null;
  recorded_by: string | null;
  created_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface VehicleMaintenanceStatus {
  vehicle_id: string;
  state: MaintenanceState;
  worst_schedule_id: string | null;
  next_due_km: number | null;
  next_due_on: string | null;
  due_count: number;
  overdue_count: number;
  last_notified_state: MaintenanceState | null;
  last_notified_at: string | null;
  /** Phase 8.1 — the weekly dedupe key for the fuel-anomaly notification. */
  last_fuel_anomaly_at: string | null;
  computed_at: string;
}

export interface Expense {
  id: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  vehicle_id: string | null;
  trip_id: string | null;
  category: ExpenseCategory;
  amount_yer: number;
  incurred_on: string;
  description: string | null;
  source: ExpenseSource;
  source_id: string | null;
  /** Filled by the Phase 10 ledger when the source row is deleted. */
  reversal_entry_id: string | null;
  recorded_by: string | null;
  created_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
}

export interface FleetSettings {
  id: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  remind_km: number;
  remind_days: number;
  block_overdue_assignment: boolean;
  fuel_anomaly_percent: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/* ---------------------------------------------------------------------------------------------
 * Phase 9 — payments
 *
 * Hand-maintained to mirror `supabase/migrations/00030_payments.sql`: the Supabase CLI is not available
 * in this environment, so `npm run db:types` re-stamps the hash instead of regenerating. The drift check
 * in `npm run sql:check` is what keeps these honest — it compares this file against the live schema, so a
 * column that exists in SQL and not here fails the build, not the browser.
 * ------------------------------------------------------------------------------------------- */

export type PaymentMethod =
  | 'jaib'
  | 'cash_one'
  | 'mfloos'
  | 'yempay'
  | 'kuraimi'
  | 'tadhamon'
  | 'cash_desk'
  | 'bank_transfer'
  | 'other';

export type PaymentAccountKind = 'platform' | 'owner' | 'agent';
export type PaymentAccountStatus = 'pending_verification' | 'active' | 'archived';

export type PaymentIntentStatus =
  'awaiting_proof' | 'awaiting_confirmation' | 'confirmed' | 'rejected' | 'expired' | 'cancelled';

export type PaymentIntentPurpose = 'booking' | 'deposit' | 'balance' | 'subscription';
export type RefundStatus = 'requested' | 'approved' | 'rejected' | 'paid';
export type AgentTxKind = 'cash_in' | 'settlement' | 'adjustment' | 'refund_out';
export type PayoutStatus = 'requested' | 'approved' | 'paid' | 'rejected';
export type PaymentOutboxKind =
  'payment_confirmed' | 'payment_reversed' | 'refund_paid' | 'payout_paid';

export interface PaymentAccount {
  id: string;
  kind: PaymentAccountKind;
  method: PaymentMethod;
  owner_user_id: string | null;
  owner_org_id: string | null;
  provider_label: string | null;
  account_number: string;
  holder_name: string;
  instructions_ar: string | null;
  instructions_en: string | null;
  status: PaymentAccountStatus;
  is_default: boolean;
  verification_document_path: string | null;
  verified_by: string | null;
  verified_at: string | null;
  archived_at: string | null;
  archive_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentIntent {
  id: string;
  code: string;
  purpose: PaymentIntentPurpose;
  booking_id: string | null;
  payer_id: string;
  payee_account_id: string | null;
  method: PaymentMethod;
  currency: string;
  amount_yer: number;
  status: PaymentIntentStatus;
  client_reference: string | null;
  reference_no: string | null;
  proof_path: string | null;
  proof_hash: string | null;
  proof_uploaded_at: string | null;
  expires_at: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejected_reason: string | null;
  cancelled_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Refund {
  id: string;
  code: string;
  booking_id: string;
  intent_id: string | null;
  amount_yer: number;
  status: RefundStatus;
  reason: string;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  paid_by: string | null;
  paid_at: string | null;
  payment_reference: string | null;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  user_id: string;
  org_id: string | null;
  float_balance_yer: number;
  credit_limit_yer: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AgentTransaction {
  id: string;
  agent_id: string;
  kind: AgentTxKind;
  amount_yer: number;
  balance_after_yer: number;
  intent_id: string | null;
  actor_id: string | null;
  note: string | null;
  created_at: string;
}

export interface Payout {
  id: string;
  code: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  amount_yer: number;
  status: PayoutStatus;
  method: PaymentMethod;
  destination_account_id: string | null;
  requested_by: string;
  requested_at: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_reason: string | null;
  paid_by: string | null;
  paid_at: string | null;
  payment_reference: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayoutItem {
  id: string;
  payout_id: string;
  source_kind: 'booking' | 'agent' | 'adjustment';
  source_id: string | null;
  amount_yer: number;
}

export interface PaymentOutboxRow {
  id: string;
  kind: PaymentOutboxKind;
  source_table: 'payment_intents' | 'refunds' | 'payouts';
  source_id: string;
  amount_yer: number;
  currency: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  actor_id: string | null;
  payload: Json;
  created_at: string;
  consumed_at: string | null;
}

export interface Trip {
  id: string;
  code: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  vehicle_id: string;
  driver_id: string | null;
  origin_governorate_id: string;
  destination_governorate_id: string;
  departure_at: string;
  departure_date: string | null;
  arrive_estimate_minutes: number;
  seats_total: number;
  seats_available: number;
  booking_mode: TripBookingMode;
  pricing_mode: TripPricingMode;
  price_per_seat_yer: number | null;
  whole_trip_price_yer: number | null;
  discount_kind: TripDiscountKind;
  discount_value: number;
  discount_scope: TripDiscountScope;
  gender_policy: TripGenderPolicy;
  payment_policy: TripPaymentPolicy;
  /** Only read when `payment_policy = 'deposit'`: the share of the fare due before the seat is held. */
  deposit_percent: number;
  luggage_allowance_kg: number | null;
  policies: Json;
  notes: string | null;
  status: TripStatus;
  verification_status: VerificationStatus;
  verified_by: string | null;
  verified_at: string | null;
  verification_note: string | null;
  published_at: string | null;
  featured_until: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  completed_at: string | null;
  /** Set by `cmd_start_trip`; a trip cannot be `in_progress` without it. */
  started_at: string | null;
  /** The highest stop the driver has announced reaching (`cmd_mark_stop_reached`). */
  last_stop_seq: number | null;
  /** Newest position report (monotonic). Staleness is `now() - last_ping_at > 21 min`. */
  last_ping_at: string | null;
  /** The 24-hex code a checkpoint scans (`get_trip_for_staff`). Issued on verification. */
  qr_token: string | null;
  created_at: string;
  updated_at: string;
}

export interface TripStop {
  id: string;
  trip_id: string;
  seq: number;
  place_id: string | null;
  governorate_id: string | null;
  name_ar: string | null;
  name_en: string | null;
  arrive_offset_minutes: number;
  price_from_origin_yer: number | null;
  created_at: string;
}

export type PingSource = 'app' | 'background' | 'web' | 'manual';

export interface TripLocationPing {
  id: string;
  trip_id: string;
  driver_id: string | null;
  recorded_at: string;
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
  speed_kmh: number | null;
  source: PingSource;
  created_at: string;
}

export interface TripProgress {
  trip_id: string;
  last_ping_at: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  nearest_stop_seq: number | null;
  distance_to_next_km: number | null;
  distance_remaining_km: number | null;
  total_distance_km: number | null;
  progress_pct: number | null;
  speed_kmh: number | null;
  eta_next_seconds: number | null;
  eta_destination_seconds: number | null;
  updated_at: string;
}

export interface TripScanLog {
  id: number;
  trip_id: string | null;
  token: string | null;
  actor_id: string | null;
  allowed: boolean;
  reason: string | null;
  created_at: string;
}

export interface TripRouteGeometry {
  trip_id: string;
  provider: string;
  polyline: Json;
  distance_km: number;
  computed_at: string;
}

export interface TripEvent {
  id: number;
  trip_id: string;
  kind: TripEventKind;
  actor_id: string | null;
  detail: Json;
  created_at: string;
}

export interface TripVerification {
  id: string;
  trip_id: string;
  submitted_by: string | null;
  submitted_at: string;
  snapshot: Json;
  outcome: unknown /* USER-DEFINED verification_outcome */ | null;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
}

export interface TripSearchRow {
  trip_id: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  status: TripStatus;
  verification_status: VerificationStatus;
  is_public: boolean;
  departure_at: string;
  departure_date: string;
  seats_available: number;
  seats_total: number;
  price_from_yer: number;
  price_per_seat_yer: number | null;
  discount_kind: TripDiscountKind;
  discount_value: number;
  booking_mode: TripBookingMode;
  pricing_mode: TripPricingMode;
  origin_governorate_id: string;
  destination_governorate_id: string;
  stop_governorate_ids: string[];
  stop_place_ids: string[];
  stop_count: number;
  gender_policy: TripGenderPolicy;
  payment_policy: TripPaymentPolicy;
  operator_name_ar: string | null;
  operator_name_en: string | null;
  vehicle_label: string | null;
  featured_until: string | null;
  is_featured: boolean;
  search_text: string;
  updated_at: string;
  /** Generated. The keyset sort key per sort — see 00038. Read-only. */
  rank_soonest: number;
  rank_cheapest: number;
  rank_featured: number;
}

export interface SearchCacheRow {
  key: string;
  payload: Json;
  expires_at: string;
}

/** 00038. The unfiltered facet counts, maintained rather than recomputed per request. */
export interface SearchCountRow {
  dimension: 'origin' | 'destination' | 'gender' | 'booking' | 'direct';
  value: string;
  count: number;
  refreshed_at: string;
}

/** `00042`. Road geometry per corridor, filled by `npm run routes:fill`. Read only through app.* functions. */
export interface RouteCacheRow {
  route_key: string;
  provider: string;
  polyline: Json;
  distance_km: number;
  computed_at: string;
}

export interface SearchBucketRow {
  origin_governorate_id: string;
  destination_governorate_id: string;
  gender_policy: string;
  booking_mode: string;
  direct: boolean;
  trips: number;
  refreshed_at: string;
}

export interface Booking {
  id: string;
  code: string;
  trip_id: string;
  passenger_id: string;
  booked_by: string;
  status: BookingStatus;
  seats: number;
  origin_stop_id: string | null;
  destination_stop_id: string | null;
  destination_seq: number | null;
  currency: string;
  unit_price_yer: number;
  subtotal_yer: number;
  discount_yer: number;
  total_yer: number;
  refund_yer: number;
  payment_status: BookingPaymentStatus;
  contact_name: string;
  contact_phone: string;
  passenger_gender: 'male' | 'female' | null;
  note: string | null;
  hold_expires_at: string | null;
  accepted_at: string | null;
  decided_by: string | null;
  reject_reason: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PassengerDocument {
  id: string;
  booking_id: string;
  id_type: IdDocumentType;
  id_number: string;
  birth_place: string | null;
  birth_date: string | null;
  photo_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentAccessLog {
  id: number;
  booking_id: string;
  actor_id: string | null;
  kind: DocumentAccessKind;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface BookingEvent {
  id: number;
  booking_id: string;
  kind: BookingEventKind;
  actor_id: string | null;
  detail: Json;
  created_at: string;
}

export interface BookingShareToken {
  id: string;
  booking_id: string;
  token: string;
  created_by: string;
  expires_at: string;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  created_at: string;
}

export interface LedgerAccount {
  code: string;
  kind: LedgerAccountKind;
  name_ar: string;
  name_en: string;
  is_system: boolean;
  created_at: string;
}

export interface JournalEntry {
  id: string;
  code: string;
  posting_date: string;
  description: string;
  source_kind: JournalSourceKind;
  source_table: string;
  source_id: string;
  currency: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  reverses_id: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

export interface LedgerEntry {
  id: string;
  journal_id: string;
  seq: number;
  account_code: string;
  direction: 'debit' | 'credit';
  amount_yer: number;
}

export interface CommissionRule {
  id: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  basis_points: number;
  min_yer: number | null;
  max_yer: number | null;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Invoice {
  id: string;
  code: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  booking_id: string | null;
  intent_id: string | null;
  subscription_id: string | null;
  journal_id: string | null;
  owner_user_id: string | null;
  owner_org_id: string | null;
  currency: string;
  subtotal_yer: number;
  commission_yer: number;
  total_yer: number;
  snapshot: Json;
  issued_at: string;
  due_on: string | null;
  /** The subscription period this invoice bills (`00045`); null for booking invoices. */
  period_start: string | null;
  paid_at: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  created_by: string | null;
  created_at: string;
}

export interface QuotaOverride {
  id: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  metric: string;
  limit_value: number | null;
  expires_at: string | null;
  granted_by: string | null;
  reason: string;
  revoked_at: string | null;
  revoked_by: string | null;
  created_at: string;
}

export interface QuotaViolation {
  id: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  actor_id: string | null;
  metric: string;
  plan_code: PlanCode | null;
  limit_value: number | null;
  used: number | null;
  action: string | null;
  created_at: string;
}

export interface UsageCounter {
  owner_user_id: string | null;
  owner_org_id: string | null;
  metric: string;
  period_start: string;
  used: number;
  updated_at: string;
}

export interface Subscription {
  id: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  plan_code: PlanCode;
  pending_plan_code: PlanCode | null;
  status: SubscriptionStatus;
  price_yer: number;
  trial_ends_at: string | null;
  current_period_start: string;
  current_period_end: string;
  grace_ends_at: string | null;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
  cancel_reason: string | null;
  ended_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionEvent {
  id: string;
  subscription_id: string;
  kind: SubscriptionEventKind;
  from_plan: PlanCode | null;
  to_plan: PlanCode | null;
  amount_yer: number;
  invoice_id: string | null;
  journal_id: string | null;
  note: string | null;
  actor_id: string | null;
  created_at: string;
}

export interface FinanceExport {
  id: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  kind: 'statement' | 'revenue' | 'payouts' | 'invoices';
  period_from: string;
  period_to: string;
  row_count: number;
  created_by: string | null;
  created_at: string;
}

export interface ReconciliationImport {
  id: string;
  owner_user_id: string | null;
  owner_org_id: string | null;
  source: 'jaib' | 'kuraimi' | 'tadhamon' | 'cash_desk' | 'bank_transfer' | 'other';
  period_from: string;
  period_to: string;
  imported_by: string | null;
  lines_total: number;
  lines_matched: number;
  created_at: string;
}

export interface ReconciliationLine {
  id: string;
  import_id: string;
  external_ref: string | null;
  amount_yer: number;
  occurred_on: string;
  status: ReconciliationStatus;
  intent_id: string | null;
  payout_id: string | null;
  note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
}

/* ---------------------------------------------------------------------------------------------
 * Phase 11 — notifications
 *
 * Hand-maintained to mirror `supabase/migrations/00032_notifications.sql`, for the same reason as the
 * Phase 9 and 10 blocks: no Supabase CLI here, and the drift check in `npm run sql:check` is the guard.
 * ------------------------------------------------------------------------------------------- */

export interface NotificationEvent {
  kind: NotificationKind;
  title_key: string;
  priority: NotificationPriority;
  default_channels: NotificationChannel[];
  is_active: boolean;
  updated_at: string;
}

export interface NotificationSettings {
  user_id: string;
  quiet_hours_enabled: boolean;
  quiet_start: string;
  quiet_end: string;
  timezone: string;
  updated_at: string;
}

export interface NotificationPreference {
  user_id: string;
  kind: NotificationKind;
  channel: NotificationChannel;
  enabled: boolean;
  updated_at: string;
}

export interface DeviceToken {
  id: string;
  user_id: string;
  platform: 'ios' | 'android' | 'web';
  token: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

export interface NotificationDelivery {
  id: string;
  notification_id: string;
  user_id: string;
  channel: NotificationChannel;
  status: NotificationDeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  claimed_at: string | null;
  last_error: string | null;
  provider_ref: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface NotificationDeliveryAttempt {
  id: string;
  delivery_id: string;
  attempt: number;
  outcome: 'sent' | 'failed';
  error: string | null;
  provider_ref: string | null;
  created_at: string;
}

export interface SavedSearch {
  id: string;
  user_id: string;
  label: string | null;
  filters: Json;
  notify: boolean;
  /** One summary a day instead of a message per matching trip. */
  digest: boolean;
  fingerprint: string;
  last_matched_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SavedSearchMatch {
  id: string;
  saved_search_id: string;
  trip_id: string;
  notified_at: string;
  /** Set when a daily digest has counted this match. */
  digested_at: string | null;
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
      plans: {
        Row: Plan;
        Insert: Partial<Plan> & { code: PlanCode; name_ar: string; name_en: string };
        Update: Partial<Plan>;
      };
      plan_limits: {
        Row: PlanLimit;
        Insert: PlanLimit;
        Update: Partial<PlanLimit>;
      };
      vehicles: {
        Row: Vehicle;
        Insert: Partial<Vehicle> & {
          make: string;
          model: string;
          model_year: number;
          plate_number: string;
          seats_passenger: number;
          seats_total: number;
        };
        Update: Partial<Vehicle>;
      };
      vehicle_photos: {
        Row: VehiclePhoto;
        Insert: Partial<VehiclePhoto> & { vehicle_id: string; storage_path: string };
        Update: Partial<VehiclePhoto>;
      };
      vehicle_documents: {
        Row: VehicleDocument;
        Insert: Partial<VehicleDocument> & {
          vehicle_id: string;
          kind: VehicleDocument['kind'];
          storage_path: string;
        };
        Update: Partial<VehicleDocument>;
      };
      driver_profiles: {
        Row: DriverProfile;
        Insert: Partial<DriverProfile> & { invited_phone: string; full_name: string };
        Update: Partial<DriverProfile>;
      };
      vehicle_driver_assignments: {
        Row: VehicleDriverAssignment;
        Insert: Partial<VehicleDriverAssignment> & { vehicle_id: string; driver_id: string };
        Update: Partial<VehicleDriverAssignment>;
      };
      odometer_readings: {
        Row: OdometerReading;
        Insert: Partial<OdometerReading> & {
          vehicle_id: string;
          reading_km: number;
          kind: OdometerKind;
        };
        Update: Partial<OdometerReading>;
      };
      fuel_logs: {
        Row: FuelLog;
        Insert: Partial<FuelLog> & {
          vehicle_id: string;
          odometer_km: number;
          litres: number;
          price_per_litre_yer: number;
        };
        Update: Partial<FuelLog>;
      };
      maintenance_schedules: {
        Row: MaintenanceSchedule;
        Insert: Partial<MaintenanceSchedule> & {
          vehicle_id: string;
          kind: MaintenanceKind;
        };
        Update: Partial<MaintenanceSchedule>;
      };
      maintenance_records: {
        Row: MaintenanceRecord;
        Insert: Partial<MaintenanceRecord> & {
          vehicle_id: string;
          kind: MaintenanceKind;
        };
        Update: Partial<MaintenanceRecord>;
      };
      vehicle_maintenance_status: {
        Row: VehicleMaintenanceStatus;
        Insert: Partial<VehicleMaintenanceStatus> & { vehicle_id: string };
        Update: Partial<VehicleMaintenanceStatus>;
      };
      expenses: {
        Row: Expense;
        Insert: Partial<Expense> & {
          category: ExpenseCategory;
          amount_yer: number;
          incurred_on: string;
        };
        Update: Partial<Expense>;
      };
      fleet_settings: {
        Row: FleetSettings;
        Insert: Partial<FleetSettings>;
        Update: Partial<FleetSettings>;
      };
      payment_accounts: {
        Row: PaymentAccount;
        Insert: Partial<PaymentAccount> & {
          kind: PaymentAccountKind;
          method: PaymentMethod;
          account_number: string;
          holder_name: string;
        };
        Update: Partial<PaymentAccount>;
      };
      payment_intents: {
        Row: PaymentIntent;
        Insert: Partial<PaymentIntent> & {
          purpose: PaymentIntentPurpose;
          payer_id: string;
          method: PaymentMethod;
          amount_yer: number;
        };
        Update: Partial<PaymentIntent>;
      };
      refunds: {
        Row: Refund;
        Insert: Partial<Refund> & {
          booking_id: string;
          amount_yer: number;
          reason: string;
          requested_by: string;
        };
        Update: Partial<Refund>;
      };
      agents: {
        Row: Agent;
        Insert: Partial<Agent> & { user_id: string };
        Update: Partial<Agent>;
      };
      agent_transactions: {
        Row: AgentTransaction;
        Insert: Partial<AgentTransaction> & {
          agent_id: string;
          kind: AgentTxKind;
          amount_yer: number;
          balance_after_yer: number;
        };
        Update: Partial<AgentTransaction>;
      };
      payouts: {
        Row: Payout;
        Insert: Partial<Payout> & {
          amount_yer: number;
          requested_by: string;
        };
        Update: Partial<Payout>;
      };
      payout_items: {
        Row: PayoutItem;
        Insert: Partial<PayoutItem> & {
          payout_id: string;
          source_kind: 'booking' | 'agent' | 'adjustment';
          amount_yer: number;
        };
        Update: Partial<PayoutItem>;
      };
      payment_outbox: {
        Row: PaymentOutboxRow;
        Insert: Partial<PaymentOutboxRow> & {
          kind: PaymentOutboxKind;
          source_table: 'payment_intents' | 'refunds' | 'payouts';
          source_id: string;
          amount_yer: number;
        };
        Update: Partial<PaymentOutboxRow>;
      };
      ledger_accounts: {
        Row: LedgerAccount;
        Insert: Partial<LedgerAccount> & {
          code: string;
          kind: LedgerAccountKind;
          name_ar: string;
          name_en: string;
        };
        Update: Partial<LedgerAccount>;
      };
      journal_entries: {
        Row: JournalEntry;
        Insert: Partial<JournalEntry> & {
          code: string;
          posting_date: string;
          description: string;
          source_kind: JournalSourceKind;
          source_table: string;
          source_id: string;
        };
        Update: Partial<JournalEntry>;
      };
      ledger_entries: {
        Row: LedgerEntry;
        Insert: Partial<LedgerEntry> & {
          journal_id: string;
          seq: number;
          account_code: string;
          direction: 'debit' | 'credit';
          amount_yer: number;
        };
        Update: Partial<LedgerEntry>;
      };
      commission_rules: {
        Row: CommissionRule;
        Insert: Partial<CommissionRule> & { basis_points: number };
        Update: Partial<CommissionRule>;
      };
      invoices: {
        Row: Invoice;
        Insert: Partial<Invoice> & {
          code: string;
          kind: InvoiceKind;
          subtotal_yer: number;
          total_yer: number;
        };
        Update: Partial<Invoice>;
      };
      quota_overrides: {
        Row: QuotaOverride;
        Insert: Partial<QuotaOverride> & { metric: string; reason: string };
        Update: Partial<QuotaOverride>;
      };
      quota_violations: {
        Row: QuotaViolation;
        Insert: Partial<QuotaViolation> & { metric: string };
        Update: Partial<QuotaViolation>;
      };
      usage_counters: {
        Row: UsageCounter;
        Insert: Partial<UsageCounter> & { metric: string; period_start: string };
        Update: Partial<UsageCounter>;
      };
      subscriptions: {
        Row: Subscription;
        Insert: Partial<Subscription> & {
          plan_code: PlanCode;
          price_yer: number;
          current_period_end: string;
        };
        Update: Partial<Subscription>;
      };
      subscription_events: {
        Row: SubscriptionEvent;
        Insert: Partial<SubscriptionEvent> & {
          subscription_id: string;
          kind: SubscriptionEventKind;
        };
        Update: Partial<SubscriptionEvent>;
      };
      finance_exports: {
        Row: FinanceExport;
        Insert: Partial<FinanceExport> & {
          kind: 'statement' | 'revenue' | 'payouts' | 'invoices';
          period_from: string;
          period_to: string;
        };
        Update: Partial<FinanceExport>;
      };
      reconciliation_imports: {
        Row: ReconciliationImport;
        Insert: Partial<ReconciliationImport> & {
          source: 'jaib' | 'kuraimi' | 'tadhamon' | 'cash_desk' | 'bank_transfer' | 'other';
          period_from: string;
          period_to: string;
        };
        Update: Partial<ReconciliationImport>;
      };
      reconciliation_lines: {
        Row: ReconciliationLine;
        Insert: Partial<ReconciliationLine> & {
          import_id: string;
          amount_yer: number;
          occurred_on: string;
        };
        Update: Partial<ReconciliationLine>;
      };
      trips: {
        Row: Trip;
        Insert: Partial<Trip> & {
          vehicle_id: string;
          origin_governorate_id: string;
          destination_governorate_id: string;
          departure_at: string;
        };
        Update: Partial<Trip>;
      };
      trip_stops: {
        Row: TripStop;
        Insert: Partial<TripStop> & { trip_id: string; seq: number };
        Update: Partial<TripStop>;
      };
      trip_events: {
        Row: TripEvent;
        Insert: Partial<TripEvent> & { trip_id: string; kind: TripEventKind };
        Update: Partial<TripEvent>;
      };
      trip_location_pings: {
        Row: TripLocationPing;
        Insert: Partial<TripLocationPing> & {
          trip_id: string;
          recorded_at: string;
          latitude: number;
          longitude: number;
        };
        Update: Partial<TripLocationPing>;
      };
      trip_progress: {
        Row: TripProgress;
        Insert: Partial<TripProgress> & { trip_id: string };
        Update: Partial<TripProgress>;
      };
      trip_scan_log: {
        Row: TripScanLog;
        Insert: Partial<TripScanLog> & { allowed: boolean };
        Update: Partial<TripScanLog>;
      };
      trip_route_geometry: {
        Row: TripRouteGeometry;
        Insert: Partial<TripRouteGeometry> & {
          trip_id: string;
          provider: string;
          polyline: Json;
          distance_km: number;
        };
        Update: Partial<TripRouteGeometry>;
      };
      bookings: {
        Row: Booking;
        Insert: Partial<Booking> & {
          trip_id: string;
          passenger_id: string;
          booked_by: string;
          unit_price_yer: number;
          subtotal_yer: number;
          total_yer: number;
          contact_name: string;
          contact_phone: string;
        };
        Update: Partial<Booking>;
      };
      passenger_documents: {
        Row: PassengerDocument;
        Insert: Partial<PassengerDocument> & {
          booking_id: string;
          id_type: IdDocumentType;
          id_number: string;
        };
        Update: Partial<PassengerDocument>;
      };
      document_access_log: {
        Row: DocumentAccessLog;
        Insert: Partial<DocumentAccessLog> & {
          booking_id: string;
          kind: DocumentAccessKind;
        };
        Update: Partial<DocumentAccessLog>;
      };
      booking_events: {
        Row: BookingEvent;
        Insert: Partial<BookingEvent> & { booking_id: string; kind: BookingEventKind };
        Update: Partial<BookingEvent>;
      };
      booking_share_tokens: {
        Row: BookingShareToken;
        Insert: Partial<BookingShareToken> & {
          booking_id: string;
          token: string;
          created_by: string;
          expires_at: string;
        };
        Update: Partial<BookingShareToken>;
      };
      trip_verifications: {
        Row: TripVerification;
        Insert: Partial<TripVerification> & { trip_id: string };
        Update: Partial<TripVerification>;
      };
      trips_search: {
        Row: TripSearchRow;
        Insert: Partial<TripSearchRow> & { trip_id: string };
        Update: Partial<TripSearchRow>;
      };
      search_cache: {
        Row: SearchCacheRow;
        Insert: Partial<SearchCacheRow> & { key: string; payload: Json };
        Update: Partial<SearchCacheRow>;
      };
      search_buckets: {
        Row: SearchBucketRow;
        Insert: Partial<SearchBucketRow> & {
          origin_governorate_id: string;
          destination_governorate_id: string;
          gender_policy: string;
          booking_mode: string;
          direct: boolean;
          trips: number;
        };
        Update: Partial<SearchBucketRow>;
      };
      search_counts: {
        Row: SearchCountRow;
        Insert: Partial<SearchCountRow> & { dimension: SearchCountRow['dimension']; value: string };
        Update: Partial<SearchCountRow>;
      };
      route_cache: {
        Row: RouteCacheRow;
        Insert: Partial<RouteCacheRow> & {
          route_key: string;
          provider: string;
          polyline: Json;
          distance_km: number;
        };
        Update: Partial<RouteCacheRow>;
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
      notification_events: {
        Row: NotificationEvent;
        Insert: Partial<NotificationEvent> & { kind: NotificationKind; title_key: string };
        Update: Partial<NotificationEvent>;
      };
      notification_settings: {
        Row: NotificationSettings;
        Insert: Partial<NotificationSettings> & { user_id: string };
        Update: Partial<NotificationSettings>;
      };
      notification_preferences: {
        Row: NotificationPreference;
        Insert: Partial<NotificationPreference> & {
          user_id: string;
          kind: NotificationKind;
          channel: NotificationChannel;
          enabled: boolean;
        };
        Update: Partial<NotificationPreference>;
      };
      device_tokens: {
        Row: DeviceToken;
        Insert: Partial<DeviceToken> & {
          user_id: string;
          platform: DeviceToken['platform'];
          token: string;
        };
        Update: Partial<DeviceToken>;
      };
      notification_deliveries: {
        Row: NotificationDelivery;
        Insert: Partial<NotificationDelivery> & {
          notification_id: string;
          user_id: string;
          channel: NotificationChannel;
        };
        Update: Partial<NotificationDelivery>;
      };
      notification_delivery_attempts: {
        Row: NotificationDeliveryAttempt;
        Insert: Partial<NotificationDeliveryAttempt> & {
          delivery_id: string;
          attempt: number;
          outcome: NotificationDeliveryAttempt['outcome'];
        };
        Update: Partial<NotificationDeliveryAttempt>;
      };
      saved_searches: {
        Row: SavedSearch;
        Insert: Partial<SavedSearch> & { user_id: string; filters: Json; fingerprint: string };
        Update: Partial<SavedSearch>;
      };
      saved_search_matches: {
        Row: SavedSearchMatch;
        Insert: Partial<SavedSearchMatch> & { saved_search_id: string; trip_id: string };
        Update: Partial<SavedSearchMatch>;
      };
    };
    Views: Record<string, never>;
    /**
     * The three trip RPCs. They are `security definer` functions granted to `anon` (the marketplace) and
     * to `authenticated` (the review queue), so they are part of the API surface the web reads — typed
     * here rather than cast away at every call site.
     */
    Functions: {
      get_trip_progress: {
        Args: { p_code: string };
        Returns: Json;
      };
      /**
       * Phase 9. The payout cap, with the owner derived from the session rather than from an argument —
       * the one money helper a signed-in user may call (`app.owner_available_yer` stays service-only).
       */
      my_available_payout_yer: {
        Args: { p_org_id?: string | null };
        Returns: number;
      };
      staff_scan: {
        Args: { p_token: string };
        Returns: Json;
      };
      staff_summary: {
        Args: Record<string, never>;
        Returns: Json;
      };
      staff_manifest: {
        Args: { p_trip_id: string };
        Returns: Json;
      };
      search_public_trips: {
        Args: {
          p_locale: string;
          p_filters: Json;
          p_sort: string;
          p_cursor: string | null;
          p_limit: number;
        };
        Returns: Json;
      };
      get_trip_public: {
        Args: { p_code: string; p_locale: string };
        Returns: Json;
      };
      staff_search_trips: {
        Args: { p_actor: string; p_filters: Json; p_limit: number };
        Returns: Json;
      };
      vehicle_health: {
        Args: { p_vehicle_id: string };
        Returns: Json;
      };
      fleet_summary: {
        Args: { p_org_id?: string | null };
        Returns: Json;
      };
      fleet_report_access: {
        Args: { p_org_id?: string | null };
        Returns: Json;
      };
      fleet_cost_detail: {
        Args: {
          p_actor: string;
          p_org_id?: string | null;
          p_from?: string | null;
          p_to?: string | null;
        };
        Returns: Json;
      };
      cmd_log_fuel: {
        Args: {
          p_actor: string;
          p_vehicle_id: string;
          p_log: Json;
          p_request_id?: string | null;
          p_ip?: string | null;
        };
        Returns: Json;
      };
      cmd_record_manual_odometer: {
        Args: {
          p_actor: string;
          p_vehicle_id: string;
          p_reading: Json;
          p_request_id?: string | null;
          p_ip?: string | null;
        };
        Returns: Json;
      };
    };
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
      trip_status: TripStatus;
      trip_event_kind: TripEventKind;
      trip_booking_mode: TripBookingMode;
      trip_pricing_mode: TripPricingMode;
      trip_discount_kind: TripDiscountKind;
      trip_discount_scope: TripDiscountScope;
      trip_gender_policy: TripGenderPolicy;
      trip_payment_policy: TripPaymentPolicy;
      maintenance_kind: MaintenanceKind;
      maintenance_state: MaintenanceState;
      expense_category: ExpenseCategory;
      expense_source: ExpenseSource;
      ledger_account_kind: LedgerAccountKind;
      journal_source_kind: JournalSourceKind;
      invoice_kind: InvoiceKind;
      invoice_status: InvoiceStatus;
      subscription_status: SubscriptionStatus;
      subscription_event_kind: SubscriptionEventKind;
      reconciliation_status: ReconciliationStatus;
    };
  };
}

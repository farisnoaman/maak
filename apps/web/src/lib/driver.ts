/**
 * The signed-in user's own driver record — the web counterpart of the mobile driver screen.
 *
 * Two shapes matter and they are not the same row:
 *
 *  - **the invitation**: an unbound `driver_profiles` row whose `invited_phone` is this account's number.
 *    It is readable only through the `driver_profiles_read_own_invite` policy (00018), and it disappears
 *    as soon as it is accepted, because accepting sets `user_id`.
 *  - **the profile**: the row bound to this account, which is what the licence form edits.
 *
 * Reads here never use the service role; the policies decide.
 */

import { getServerClient } from './supabase/server';

export interface DriverLicenceRecord {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly licenceNo: string | null;
  readonly licenceClass: string | null;
  readonly licenceExpiry: string | null;
  readonly licencePhotoPath: string | null;
  readonly status: string;
  readonly verificationStatus: string;
  readonly verificationNote: string | null;
}

export interface DriverState {
  readonly configured: boolean;
  /** The row bound to this account, if any. */
  readonly driver: DriverLicenceRecord | null;
  /** An unbound invitation addressed to this account's phone. */
  readonly invite: DriverLicenceRecord | null;
}

const COLUMNS =
  'id, full_name, invited_phone, licence_no, licence_class, licence_expiry, licence_photo_path, status, verification_status, verification_note';

const EMPTY: DriverState = { configured: false, driver: null, invite: null };

function str(value: unknown): string | null {
  return value == null ? null : String(value);
}

function toRecord(row: Record<string, unknown>): DriverLicenceRecord {
  return {
    id: String(row.id ?? ''),
    fullName: String(row.full_name ?? ''),
    phone: String(row.invited_phone ?? ''),
    licenceNo: str(row.licence_no),
    licenceClass: str(row.licence_class),
    licenceExpiry: str(row.licence_expiry),
    licencePhotoPath: str(row.licence_photo_path),
    status: String(row.status ?? 'invited'),
    verificationStatus: String(row.verification_status ?? 'unverified'),
    verificationNote: str(row.verification_note),
  };
}

export async function loadDriverState(): Promise<DriverState> {
  const client = await getServerClient();
  if (!client) return EMPTY;

  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return { configured: true, driver: null, invite: null };

  const [boundResult, inviteResult] = await Promise.all([
    client
      .from('driver_profiles')
      .select(COLUMNS)
      .eq('user_id', user.id)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle(),
    // The policy narrows this to invitations addressed to this account; the filter is the second lock on
    // the same door, and it keeps the intent readable at the call site.
    client
      .from('driver_profiles')
      .select(COLUMNS)
      .is('user_id', null)
      .eq('status', 'invited')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle(),
  ]);

  const bound = boundResult.data as Record<string, unknown> | null;
  const invited = inviteResult.data as Record<string, unknown> | null;

  return {
    configured: true,
    driver: bound ? toRecord(bound) : null,
    invite: bound ? null : invited ? toRecord(invited) : null,
  };
}

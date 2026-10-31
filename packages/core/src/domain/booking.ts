/**
 * Booking vocabulary — the small amount of presentation logic that belongs to the domain rather than to
 * one screen.
 *
 * The status names are the enum in `00019`; the keys are the dictionary entries every client renders. A
 * status that exists in SQL and has no label would leak `cancelled_by_passenger` into an Arabic page,
 * which is the failure mode this file exists to make impossible.
 */

import type { TranslationKey } from '../i18n/dictionaries';

export const BOOKING_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'expired',
  'cancelled_by_passenger',
  'cancelled_by_operator',
  'no_show',
  'completed',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_STATUS_KEY: Record<BookingStatus, TranslationKey> = {
  pending: 'bookings.status.pending',
  accepted: 'bookings.status.accepted',
  rejected: 'bookings.status.rejected',
  expired: 'bookings.status.expired',
  cancelled_by_passenger: 'bookings.status.cancelledByPassenger',
  cancelled_by_operator: 'bookings.status.cancelledByOperator',
  no_show: 'bookings.status.noShow',
  completed: 'bookings.status.completed',
};

export const ID_TYPE_KEY: Record<string, TranslationKey> = {
  national_id: 'bookings.id.national_id',
  passport: 'bookings.id.passport',
  iqama: 'bookings.id.iqama',
  other: 'bookings.id.other',
};

/** A booking the passenger can still cancel: it is live, and the trip has not started. */
export function isPassengerCancellable(status: string): boolean {
  return status === 'pending' || status === 'accepted';
}

/** The statuses that occupy a seat. Used by badges and by the operator's "seats sold" count. */
export function holdsSeat(status: string): boolean {
  return status === 'pending' || status === 'accepted';
}

/** Badge tone for a status: a colour is a claim, so it is decided once, here. */
export function bookingTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'accepted':
    case 'completed':
      return 'success';
    case 'pending':
      return 'warning';
    case 'rejected':
    case 'cancelled_by_operator':
      return 'danger';
    case 'expired':
    case 'no_show':
      return 'neutral';
    default:
      return 'neutral';
  }
}

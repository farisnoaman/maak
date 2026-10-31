/**
 * Bookings — the shared contract between the booking wizard, the operator inbox and the gateway
 * (Phase 5).
 *
 * One edge function (`bookings`) dispatches on `action`, and every branch maps to exactly one `cmd_*`
 * from migration 00019: one request, one transaction, one audit row. Reads are not here — a passenger's
 * bookings and the operator's manifest are RLS-filtered PostgREST reads, because a read that needs a
 * transaction is a read that will be slow.
 *
 * The fare is never an input. `claimedTotalMinor` is what the page showed the passenger; the command
 * recomputes the real total and refuses the booking with `PRICE_CHANGED` when they differ (ADR-24).
 */

import { z } from 'zod';

const uuid = z.string().uuid();

/** Seats per booking: an eight-seat minibus is the top of the ladder, and a whole-trip booking is one. */
export const MAX_SEATS_PER_BOOKING = 8;

export const bookingSeatsSchema = z.number().int().min(1).max(MAX_SEATS_PER_BOOKING);

export const idDocumentTypeSchema = z.enum(['national_id', 'passport', 'iqama', 'other']);
export const bookingGenderSchema = z.enum(['male', 'female']);

/**
 * A phone number as the passenger types it. The command stores it trimmed; normalisation for matching
 * lives in the database (`app.normalize_phone`), which is also what the driver invite uses.
 */
const phone = z.string().trim().min(6).max(20);

const optionalDate = z
  .union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')])
  .nullish()
  .transform((value) => (value === '' || value == null ? null : value));

export const createBookingSchema = z.object({
  action: z.literal('booking.create'),
  tripId: uuid,
  seats: bookingSeatsSchema.default(1),
  /** The stop the passenger gets off at; `null` means the trip's final destination. */
  destinationStopId: uuid.nullish().transform((value) => value ?? null),
  /** What the page displayed. Compared, never trusted. */
  claimedTotalMinor: z.number().int().min(0).nullish(),
  contactName: z.string().trim().min(2).max(120),
  contactPhone: phone,
  gender: bookingGenderSchema.nullish(),
  note: z.string().trim().max(500).nullish(),
});

export const setPassengerDocumentSchema = z.object({
  action: z.literal('booking.setDocument'),
  bookingId: uuid,
  idType: idDocumentTypeSchema,
  idNumber: z.string().trim().min(4).max(40),
  birthPlace: z.string().trim().max(120).nullish(),
  birthDate: optionalDate,
  photoPath: z.string().trim().max(300).nullish(),
});

export const acceptBookingSchema = z.object({
  action: z.literal('booking.accept'),
  bookingId: uuid,
});

export const bulkAcceptBookingsSchema = z.object({
  action: z.literal('booking.bulkAccept'),
  bookingIds: z.array(uuid).min(1).max(50),
});

export const rejectBookingSchema = z.object({
  action: z.literal('booking.reject'),
  bookingId: uuid,
  /** The passenger reads this. Short refusals ("no") are refused by the database for that reason. */
  reason: z.string().trim().min(5).max(300),
});

export const cancelBookingByPassengerSchema = z.object({
  action: z.literal('booking.cancelByPassenger'),
  bookingId: uuid,
  reason: z.string().trim().max(300).nullish(),
});

export const cancelBookingByOperatorSchema = z.object({
  action: z.literal('booking.cancelByOperator'),
  bookingId: uuid,
  reason: z.string().trim().min(5).max(300),
});

export const markNoShowSchema = z.object({
  action: z.literal('booking.markNoShow'),
  bookingId: uuid,
});

export const shareDocumentSchema = z.object({
  action: z.literal('booking.shareLink'),
  bookingId: uuid,
});

export const bookingsActionSchema = z.discriminatedUnion('action', [
  createBookingSchema,
  setPassengerDocumentSchema,
  acceptBookingSchema,
  bulkAcceptBookingsSchema,
  rejectBookingSchema,
  cancelBookingByPassengerSchema,
  cancelBookingByOperatorSchema,
  markNoShowSchema,
  shareDocumentSchema,
]);

export type BookingsAction = z.infer<typeof bookingsActionSchema>;
export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type SetPassengerDocumentInput = z.infer<typeof setPassengerDocumentSchema>;

/**
 * The scope facts an actor claims.
 *
 * A claim, not a grant: `cmd_*` re-derives ownership from the booking's trip, so an operator who
 * claims `isOwner` for somebody else's booking gets a 42501 rather than access.
 */
export function bookingsScope(input: BookingsAction) {
  switch (input.action) {
    // The passenger's own actions. `isBooker` is the claim the policy needs (`booking.cancelAsPassenger`
    // is booker-scoped); the command still re-derives ownership from `bookings.passenger_id`, so the claim
    // buys nothing beyond a first look at the request.
    case 'booking.create':
    case 'booking.setDocument':
    case 'booking.cancelByPassenger':
    case 'booking.shareLink':
      return { isBooker: true };
    default:
      return { isOwner: true, isOrgMember: true };
  }
}

export const bookingResultSchema = z
  .object({
    booking: z.record(z.string(), z.unknown()).optional(),
    document: z.record(z.string(), z.unknown()).optional(),
    refund: z
      .object({
        amountMinor: z.number().optional(),
        eligible: z.boolean().optional(),
        appliedBasisPoints: z.number().optional(),
        reason: z.string().optional(),
      })
      .optional(),
    accepted: z.array(z.string()).optional(),
    refused: z.array(z.string()).optional(),
    seatsAvailable: z.number().optional(),
    token: z.string().optional(),
    expiresAt: z.string().optional(),
    path: z.string().optional(),
    requestId: z.string().optional(),
  })
  .passthrough();

export const bookingsCommandSpec = {
  path: 'bookings',
  input: bookingsActionSchema,
  output: bookingResultSchema,
  mutating: true,
} as const;

/** Action → SQL function and arguments. The names are checked against the migrations by a guard. */
export function bookingsCommandArgs(
  action: BookingsAction,
  actorId: string,
  audit: { readonly p_request_id: string; readonly p_ip: string | null },
): { fn: string; args: Record<string, unknown> } {
  switch (action.action) {
    case 'booking.create':
      return {
        fn: 'cmd_create_booking',
        args: {
          p_actor: actorId,
          p_trip_id: action.tripId,
          p_seats: action.seats,
          p_destination_stop_id: action.destinationStopId ?? null,
          p_claimed_total: action.claimedTotalMinor ?? null,
          p_contact_name: action.contactName,
          p_contact_phone: action.contactPhone,
          p_gender: action.gender ?? null,
          p_note: action.note ?? null,
          ...audit,
        },
      };
    case 'booking.setDocument':
      return {
        fn: 'cmd_set_passenger_document',
        args: {
          p_actor: actorId,
          p_booking_id: action.bookingId,
          p_id_type: action.idType,
          p_id_number: action.idNumber,
          p_birth_place: action.birthPlace ?? null,
          p_birth_date: action.birthDate,
          p_photo_path: action.photoPath ?? null,
          ...audit,
        },
      };
    case 'booking.accept':
      return {
        fn: 'cmd_accept_booking',
        args: { p_actor: actorId, p_booking_id: action.bookingId, ...audit },
      };
    case 'booking.bulkAccept':
      return {
        fn: 'cmd_bulk_accept_bookings',
        // `uuid[]`, not `jsonb`: node-postgres serialises an array as a Postgres array literal, which is
        // exactly what this parameter is.
        args: { p_actor: actorId, p_booking_ids: action.bookingIds, ...audit },
      };
    case 'booking.reject':
      return {
        fn: 'cmd_reject_booking',
        args: {
          p_actor: actorId,
          p_booking_id: action.bookingId,
          p_reason: action.reason,
          ...audit,
        },
      };
    case 'booking.cancelByPassenger':
      return {
        fn: 'cmd_cancel_booking_by_passenger',
        args: {
          p_actor: actorId,
          p_booking_id: action.bookingId,
          p_reason: action.reason ?? null,
          ...audit,
        },
      };
    case 'booking.cancelByOperator':
      return {
        fn: 'cmd_cancel_booking_by_operator',
        args: {
          p_actor: actorId,
          p_booking_id: action.bookingId,
          p_reason: action.reason,
          ...audit,
        },
      };
    case 'booking.markNoShow':
      return {
        fn: 'cmd_mark_no_show',
        args: { p_actor: actorId, p_booking_id: action.bookingId, ...audit },
      };
    case 'booking.shareLink':
      return {
        fn: 'create_id_share_link',
        args: { p_actor: actorId, p_booking_id: action.bookingId, ...audit },
      };
  }
}

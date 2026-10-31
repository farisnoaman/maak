import { describe, expect, it } from 'vitest';
import {
  bookingsActionSchema,
  bookingsCommandArgs,
  bookingsCommandSpec,
  bookingsScope,
  createBookingSchema,
  setPassengerDocumentSchema,
  type BookingsAction,
} from '../src/api/bookings';
import { BOOKING_REFUND_POLICY, computeRefund } from '../src/domain/finance';
import { can } from '../src/domain/policy';
import type { Actor, Role } from '../src/domain/policy';

const actor = (roles: Role[]): Actor => ({
  userId: '44444444-4444-4444-8444-444444444444',
  roles,
  verification: 'unverified',
  plan: 'basic',
});

const audit = { p_request_id: 'req-1', p_ip: null };
const bookingId = '11111111-1111-4111-8111-111111111111';
const tripId = '22222222-2222-4222-8222-222222222222';

describe('booking input', () => {
  it('defaults to one seat and a null destination stop', () => {
    const parsed = createBookingSchema.parse({
      action: 'booking.create',
      tripId,
      contactName: 'مسافر',
      contactPhone: '+967733500002',
    });
    expect(parsed.seats).toBe(1);
    expect(parsed.destinationStopId).toBeNull();
  });

  it('refuses zero seats, a one-character name and a short phone', () => {
    const base = {
      action: 'booking.create' as const,
      tripId,
      contactName: 'مسافر',
      contactPhone: '+967733500002',
    };
    expect(createBookingSchema.safeParse({ ...base, seats: 0 }).success).toBe(false);
    expect(createBookingSchema.safeParse({ ...base, seats: 9 }).success).toBe(false);
    expect(createBookingSchema.safeParse({ ...base, contactName: 'م' }).success).toBe(false);
    expect(createBookingSchema.safeParse({ ...base, contactPhone: '123' }).success).toBe(false);
  });

  it('treats an empty birth date as "not set" rather than a bad format', () => {
    const parsed = setPassengerDocumentSchema.parse({
      action: 'booking.setDocument',
      bookingId,
      idType: 'national_id',
      idNumber: '01-2345678',
      birthDate: '',
    });
    expect(parsed.birthDate).toBeNull();
  });

  it('requires a real rejection reason', () => {
    expect(
      bookingsActionSchema.safeParse({ action: 'booking.reject', bookingId, reason: 'no' }).success,
    ).toBe(false);
    expect(
      bookingsActionSchema.safeParse({
        action: 'booking.reject',
        bookingId,
        reason: 'المركبة ممتلئة',
      }).success,
    ).toBe(true);
  });

  it('caps a bulk accept at fifty bookings', () => {
    const ids = Array.from({ length: 51 }, (_, index) => `${index}`.padStart(8, '1'));
    expect(
      bookingsActionSchema.safeParse({ action: 'booking.bulkAccept', bookingIds: ids }).success,
    ).toBe(false);
  });
});

describe('action → command mapping', () => {
  const cases: { action: BookingsAction; fn: string }[] = [
    {
      action: {
        action: 'booking.create',
        tripId,
        seats: 2,
        destinationStopId: null,
        claimedTotalMinor: 20000,
        contactName: 'مسافر',
        contactPhone: '+967733500002',
        gender: null,
        note: null,
      },
      fn: 'cmd_create_booking',
    },
    {
      action: {
        action: 'booking.setDocument',
        bookingId,
        idType: 'passport',
        idNumber: 'P-1',
        birthPlace: null,
        birthDate: null,
        photoPath: null,
      },
      fn: 'cmd_set_passenger_document',
    },
    { action: { action: 'booking.accept', bookingId }, fn: 'cmd_accept_booking' },
    {
      action: { action: 'booking.bulkAccept', bookingIds: [bookingId] },
      fn: 'cmd_bulk_accept_bookings',
    },
    {
      action: { action: 'booking.reject', bookingId, reason: 'المركبة ممتلئة' },
      fn: 'cmd_reject_booking',
    },
    {
      action: { action: 'booking.cancelByPassenger', bookingId, reason: null },
      fn: 'cmd_cancel_booking_by_passenger',
    },
    {
      action: { action: 'booking.cancelByOperator', bookingId, reason: 'تعطلت المركبة' },
      fn: 'cmd_cancel_booking_by_operator',
    },
    { action: { action: 'booking.markNoShow', bookingId }, fn: 'cmd_mark_no_show' },
    { action: { action: 'booking.shareLink', bookingId }, fn: 'create_id_share_link' },
  ];

  it.each(cases)('$fn receives the actor and the audit fields', ({ action, fn }) => {
    const { fn: name, args } = bookingsCommandArgs(action, 'actor-1', audit);
    expect(name).toBe(fn);
    expect(args.p_actor).toBe('actor-1');
    expect(args).toMatchObject(audit);
  });

  it('passes an array for a uuid[] parameter, so node-postgres builds a Postgres array', () => {
    const { args } = bookingsCommandArgs(
      { action: 'booking.bulkAccept', bookingIds: [bookingId, tripId] },
      'actor-1',
      audit,
    );
    expect(Array.isArray(args.p_booking_ids)).toBe(true);
  });

  it('declares a mutating spec on the bookings path', () => {
    expect(bookingsCommandSpec.path).toBe('bookings');
    expect(bookingsCommandSpec.mutating).toBe(true);
  });

  it('claims booker for a passenger action and ownership for an operator action', () => {
    // `booking.cancelAsPassenger` is booker-scoped in the policy, so an empty scope would deny the very
    // passenger the command belongs to. The claim is not a grant: the command re-reads the booking.
    const scope = bookingsScope({ action: 'booking.cancelByPassenger', bookingId, reason: null });
    expect(scope).toEqual({ isBooker: true });
    expect(can(actor(['passenger']), 'booking.cancelAsPassenger', scope)).toBe(true);
    expect(bookingsScope({ action: 'booking.accept', bookingId })).toMatchObject({ isOwner: true });
  });
});

describe('the booking refund ladder (mirrored by app.compute_refund)', () => {
  const refund = (hoursBeforeStart: number) =>
    computeRefund({ paidMinor: 10_000, hoursBeforeStart, policy: BOOKING_REFUND_POLICY });

  it('refunds in full at 48 hours', () => {
    expect(refund(48)).toMatchObject({
      amountMinor: 10_000,
      appliedBasisPoints: 10_000,
      eligible: true,
    });
  });

  it('refunds 75 % at 24 hours', () => {
    expect(refund(24)).toMatchObject({
      amountMinor: 7_500,
      appliedBasisPoints: 7_500,
      reason: 'partial',
    });
  });

  it('refunds 50 % at 2 hours', () => {
    expect(refund(2)).toMatchObject({ amountMinor: 5_000, appliedBasisPoints: 5_000 });
  });

  it('refuses inside the cutoff', () => {
    expect(refund(1.9)).toMatchObject({
      amountMinor: 0,
      eligible: false,
      reason: 'outside_policy',
    });
  });

  it('has nothing to refund when nothing was paid', () => {
    expect(
      computeRefund({ paidMinor: 0, hoursBeforeStart: 10, policy: BOOKING_REFUND_POLICY }).reason,
    ).toBe('nothing_paid');
  });

  it('never refunds more than was paid', () => {
    expect(
      computeRefund({ paidMinor: 333, hoursBeforeStart: 30, policy: BOOKING_REFUND_POLICY })
        .amountMinor,
    ).toBe(250);
  });
});

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  bookingsCommandSpec,
  errorKey,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { getApiClient, uploadPassengerId } from '@/lib/api';

type Failure = { readonly code: string; readonly fields?: Record<string, string> };

function useCommand(locale: Locale) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function run(input: Record<string, unknown>) {
    const client = getApiClient();
    if (!client) {
      setFailure({ code: 'INTERNAL' });
      return null;
    }
    setBusy(true);
    setFailure(null);
    const result = await client.call(bookingsCommandSpec, input as never);
    setBusy(false);
    if (!result.ok) {
      setFailure(result.error as Failure);
      return null;
    }
    router.refresh();
    return result.data as Record<string, unknown>;
  }

  const message = failure
    ? failure.fields
      ? translate(locale, 'errors.VALIDATION_FAILED')
      : translate(locale, errorKey(failure.code as never))
    : null;

  return { busy, message, run };
}

/**
 * What the passenger can do about their own booking: cancel it inside the window, or hand the operator a
 * 72-hour link to the ID instead of messaging a photograph into a chat that nobody can audit.
 */
export function PassengerBookingActions({
  locale,
  bookingId,
  cancellable,
}: {
  readonly locale: Locale;
  readonly bookingId: string;
  readonly cancellable: boolean;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, run } = useCommand(locale);
  const [share, setShare] = useState<{ path: string; expiresAt: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const shareUrl =
    share && typeof window !== 'undefined' ? `${window.location.origin}${share.path}` : '';

  return (
    <div className="booking-actions">
      {message ? (
        <p className="ui-alert ui-alert--error" role="alert">
          {message}
        </p>
      ) : null}

      {cancellable ? (
        confirming ? (
          <div className="booking-actions__confirm">
            <p>{t('bookings.cancelConfirm')}</p>
            <div className="form-actions">
              <Button
                variant="danger"
                loading={busy}
                onClick={() => void run({ action: 'booking.cancelByPassenger', bookingId })}
              >
                {t('bookings.cancelYes')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            {t('bookings.cancel')}
          </Button>
        )
      ) : null}

      <Button
        variant="ghost"
        loading={busy}
        onClick={async () => {
          const data = await run({ action: 'booking.shareLink', bookingId });
          if (data?.token && data?.expiresAt) {
            setShare({ path: String(data.path), expiresAt: String(data.expiresAt) });
          }
        }}
      >
        {t('bookings.shareId')}
      </Button>

      {share ? (
        <div className="booking-share">
          <p className="trip-form__hint">{t('bookings.shareExplain')}</p>
          <p dir="ltr" className="booking-share__url">
            {shareUrl}
          </p>
          <div className="form-actions">
            <a
              className="ui-btn ui-btn--ghost ui-btn--md"
              href={`https://wa.me/?text=${encodeURIComponent(shareUrl)}`}
              target="_blank"
              rel="noreferrer"
            >
              {t('bookings.shareWhatsApp')}
            </a>
            <Button variant="subtle" onClick={() => void navigator.clipboard?.writeText(shareUrl)}>
              {t('bookings.copyLink')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Accept, reject with a reason, or record a no-show — the three things an operator does about a seat. */
export function OperatorBookingActions({
  locale,
  bookingId,
  status,
}: {
  readonly locale: Locale;
  readonly bookingId: string;
  readonly status: string;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const { busy, message, run } = useCommand(locale);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div className="booking-actions">
      {message ? (
        <p className="ui-alert ui-alert--error" role="alert">
          {message}
        </p>
      ) : null}

      {status === 'pending' ? (
        <div className="form-actions">
          <Button loading={busy} onClick={() => void run({ action: 'booking.accept', bookingId })}>
            {t('bookings.accept')}
          </Button>
          <Button variant="danger" onClick={() => setRejecting((value) => !value)}>
            {t('bookings.reject')}
          </Button>
        </div>
      ) : null}

      {status === 'accepted' ? (
        <Button
          variant="subtle"
          loading={busy}
          onClick={() => void run({ action: 'booking.markNoShow', bookingId })}
        >
          {t('bookings.markNoShow')}
        </Button>
      ) : null}

      {rejecting ? (
        <div className="booking-actions__reject">
          <Field
            label={t('bookings.rejectReason')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={5}
            required
            hint={t('bookings.rejectReasonHint')}
          />
          <Button
            variant="danger"
            loading={busy}
            disabled={reason.trim().length < 5}
            onClick={() => void run({ action: 'booking.reject', bookingId, reason: reason.trim() })}
          >
            {t('bookings.rejectConfirm')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Accept every pending request that is still holding a seat, and report the ones that were not. */
export function BulkAccept({
  locale,
  bookingIds,
}: {
  readonly locale: Locale;
  readonly bookingIds: readonly string[];
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, run } = useCommand(locale);
  const [outcome, setOutcome] = useState<{ accepted: number; refused: number } | null>(null);

  if (bookingIds.length === 0) return null;

  return (
    <div className="booking-actions">
      {message ? (
        <p className="ui-alert ui-alert--error" role="alert">
          {message}
        </p>
      ) : null}
      {outcome ? (
        <p className="ui-alert" role="status">
          {t('bookings.bulkResult', { accepted: outcome.accepted, refused: outcome.refused })}
        </p>
      ) : null}
      <Button
        loading={busy}
        onClick={async () => {
          const data = await run({ action: 'booking.bulkAccept', bookingIds: [...bookingIds] });
          if (data) {
            setOutcome({
              accepted: Array.isArray(data.accepted) ? data.accepted.length : 0,
              refused: Array.isArray(data.refused) ? data.refused.length : 0,
            });
          }
        }}
      >
        {t('bookings.acceptAll', { count: bookingIds.length })}
      </Button>
    </div>
  );
}

/**
 * The passenger's ID, on the web.
 *
 * Same order as everything else in this app: push the image into `<booking-id>/…` in the private bucket,
 * then record the path with `booking.setDocument`, which refuses a path that is not in that folder or
 * names no stored object.
 */
export function IdentityForm({
  locale,
  booking,
}: {
  readonly locale: Locale;
  readonly booking: {
    readonly id: string;
    readonly document: {
      readonly idType: string;
      readonly idNumber: string;
      readonly birthPlace: string | null;
      readonly birthDate: string | null;
      readonly photoPath: string | null;
    } | null;
  };
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const { busy, message, run } = useCommand(locale);
  const [idType, setIdType] = useState(booking.document?.idType ?? 'national_id');
  const [idNumber, setIdNumber] = useState(booking.document?.idNumber ?? '');
  const [birthPlace, setBirthPlace] = useState(booking.document?.birthPlace ?? '');
  const [birthDate, setBirthDate] = useState(booking.document?.birthDate?.slice(0, 10) ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save() {
    let photoPath = booking.document?.photoPath ?? undefined;
    if (file) {
      const upload = await uploadPassengerId(file, booking.id);
      if (!upload.ok) {
        setNotice(
          upload.error === 'not-configured'
            ? t('verification.notConfigured')
            : t('bookings.idUploadFailed'),
        );
        return;
      }
      photoPath = upload.path;
    }
    const data = await run({
      action: 'booking.setDocument',
      bookingId: booking.id,
      idType,
      idNumber,
      birthPlace: birthPlace.trim() === '' ? null : birthPlace.trim(),
      birthDate: birthDate === '' ? null : birthDate,
      photoPath,
    });
    if (data) {
      setFile(null);
      setNotice(t('bookings.idSaved'));
    }
  }

  return (
    <div className="booking-identity">
      {message ? (
        <p className="ui-alert ui-alert--error" role="alert">
          {message}
        </p>
      ) : null}
      {notice ? (
        <p className="ui-alert" role="status">
          {notice}
        </p>
      ) : null}

      <div className="ui-field">
        <label className="ui-field__label" htmlFor="id-type">
          {t('bookings.idType')}
        </label>
        <select
          id="id-type"
          className="ui-input"
          value={idType}
          onChange={(event) => setIdType(event.target.value)}
        >
          <option value="national_id">{t('bookings.id.national_id')}</option>
          <option value="passport">{t('bookings.id.passport')}</option>
          <option value="iqama">{t('bookings.id.iqama')}</option>
          <option value="other">{t('bookings.id.other')}</option>
        </select>
      </div>

      <Field
        label={t('bookings.idNumber')}
        value={idNumber}
        onChange={(event) => setIdNumber(event.target.value)}
        dir="ltr"
        required
      />
      <Field
        label={t('bookings.birthPlace')}
        value={birthPlace}
        onChange={(event) => setBirthPlace(event.target.value)}
      />
      <Field
        label={t('bookings.birthDate')}
        type="date"
        value={birthDate}
        onChange={(event) => setBirthDate(event.target.value)}
      />
      <Field
        label={t('bookings.idPhoto')}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        capture="environment"
        hint={t('bookings.idPhotoHint')}
        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
      />
      {file ? <p className="trip-form__hint">{file.name}</p> : null}

      <Button loading={busy} onClick={() => void save()}>
        {t('bookings.idSave')}
      </Button>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  VERIFICATION_KEY,
  errorKey,
  fleetCommandSpec,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { getApiClient, uploadDriverLicence } from '@/lib/api';
import type { DriverLicenceRecord } from '@/lib/driver';

/**
 * The driver's licence, on the web.
 *
 * The phone app was the only place a licence could be photographed, which made the whole feature depend
 * on an app that a driver may not have installed — while the same browser that opens this page can take
 * the picture. So this panel does exactly what the phone screen does, in the same order:
 *
 *   1. push the image into `<userId>/…` in the private bucket (the storage policy pins the folder to
 *      `auth.uid()`, so this cannot be pointed at somebody else);
 *   2. record the path with `driver.setLicence`, which refuses a path that was never uploaded, refuses an
 *      expired licence, and re-opens verification because an approval of a document is invalidated by
 *      replacing the document.
 *
 * The order is not cosmetic: a failed upload must not leave a driver "verified" against a document that
 * does not exist.
 */
export function LicencePanel({
  locale,
  userId,
  driver,
  photoUrl,
}: {
  readonly locale: Locale;
  readonly userId: string;
  readonly driver: DriverLicenceRecord;
  /** A five-minute signed read, minted by the page. Null when there is no photo or it cannot be signed. */
  readonly photoUrl: string | null;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const router = useRouter();

  const [licenceNo, setLicenceNo] = useState(driver.licenceNo ?? '');
  const [licenceClass, setLicenceClass] = useState(driver.licenceClass ?? '');
  const [licenceExpiry, setLicenceExpiry] = useState(driver.licenceExpiry?.slice(0, 10) ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save() {
    setError(null);
    setNotice(null);

    if (licenceNo.trim() !== '' && licenceNo.trim().length < 3) {
      setError(t('errors.VALIDATION_FAILED'));
      return;
    }

    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }

    setBusy(true);

    let photoPath = driver.licencePhotoPath ?? undefined;
    if (file) {
      const upload = await uploadDriverLicence(file, userId);
      if (!upload.ok) {
        setBusy(false);
        // Two failures, two sentences: a missing configuration is an operator problem, a refused
        // upload is usually a file the browser could send and the bucket would not keep.
        setError(
          upload.error === 'not-configured'
            ? t('verification.notConfigured')
            : t('fleet.licenceUploadFailed'),
        );
        return;
      }
      photoPath = upload.path;
    }

    const result = await client.call(fleetCommandSpec, {
      action: 'driver.setLicence',
      driverId: driver.id,
      licenceNo: licenceNo.trim() || null,
      licenceClass: licenceClass.trim() || null,
      licenceExpiry: licenceExpiry || null,
      photoPath,
    } as never);
    setBusy(false);

    if (!result.ok) {
      setError(
        result.error.code === 'VALIDATION_FAILED' && result.error.detail
          ? result.error.detail
          : t(errorKey(result.error.code as never)),
      );
      return;
    }

    setFile(null);
    setNotice(t('fleet.licenceUploaded'));
    router.refresh();
  }

  return (
    <div className="fleet-panel">
      <div className="fleet-toolbar">
        <p className="fleet-hint">
          {t('fleet.licencePhoto')}:{' '}
          {driver.licencePhotoPath ? t('fleet.licenceUploaded') : t('fleet.licencePhotoMissing')}
        </p>
        <Badge tone={driver.verificationStatus === 'verified' ? 'success' : 'neutral'}>
          {t(VERIFICATION_KEY[driver.verificationStatus] ?? 'fleet.badgeUnverified')}
        </Badge>
      </div>

      {photoUrl ? (
        <p>
          <a href={photoUrl} target="_blank" rel="noreferrer">
            {t('fleet.viewPhoto')}
          </a>
        </p>
      ) : null}

      {driver.verificationNote ? (
        <p className="fleet-error" role="alert">
          {t('fleet.rejectReason')}: {driver.verificationNote}
        </p>
      ) : null}

      {error ? (
        <p className="fleet-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="fleet-success" role="status">
          {notice}
        </p>
      ) : null}

      <div className="fleet-form-grid">
        <Field
          label={t('fleet.licenceNo')}
          value={licenceNo}
          onChange={(event) => setLicenceNo(event.target.value)}
          autoComplete="off"
        />
        <Field
          label={t('fleet.licenceClass')}
          value={licenceClass}
          onChange={(event) => setLicenceClass(event.target.value)}
          autoComplete="off"
        />
        <Field
          label={t('fleet.licenceExpiry')}
          type="date"
          value={licenceExpiry}
          onChange={(event) => setLicenceExpiry(event.target.value)}
        />
        {/* `capture="environment"` opens the rear camera on a phone; on a laptop the same input is an
            ordinary file picker, so one control covers both. */}
        <Field
          label={t('fleet.licencePhoto')}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          hint={t('fleet.licencePhotoHint')}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </div>

      {file ? (
        <p className="fleet-hint">
          {t('fleet.selectedFile')}: {file.name}
        </p>
      ) : null}

      <p className="fleet-hint">{t('fleet.licenceNeedsReview')}</p>

      <Button loading={busy} onClick={() => void save()}>
        {t('fleet.licenceSave')}
      </Button>
    </div>
  );
}

/**
 * Accepting an invitation, in the browser.
 *
 * This exists because the invitation was previously only acceptable from the phone app *and* the phone
 * screen could not find the invitation before it was accepted — so an invited driver had no way in from
 * either client. The command matches the invitation by phone; the page only offers the button.
 */
export function AcceptInvitePanel({
  locale,
  invite,
}: {
  readonly locale: Locale;
  readonly invite: DriverLicenceRecord;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await client.call(fleetCommandSpec, { action: 'driver.accept' } as never);
    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code as never)));
      return;
    }
    router.refresh();
  }

  return (
    <div className="fleet-panel">
      <p className="fleet-row__title">{invite.fullName}</p>
      <p className="fleet-row__meta" dir="ltr">
        {invite.phone}
      </p>
      <p className="fleet-hint">{t('fleet.acceptInviteHint')}</p>
      {error ? (
        <p className="fleet-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button loading={busy} onClick={() => void accept()}>
        {t('fleet.acceptInvite')}
      </Button>
    </div>
  );
}

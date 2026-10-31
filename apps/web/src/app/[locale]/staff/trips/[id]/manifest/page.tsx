import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  departureLabel,
  formatMinor,
  isLocale,
  manifestColumns,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { TripQr } from '@/components/staff/TripQr';
import { PrintButton } from '@/components/staff/PrintButton';
import { loadAccountContext } from '@/lib/account';
import { loadManifest, type ManifestPassenger } from '@/lib/staff-ops';

/**
 * The A4 manifest.
 *
 * This page is the PDF. A server-rendered sheet with an `@page` rule and a print stylesheet produces a
 * real A4 document through the browser's own "Save as PDF" — the fonts are the reader's, so Arabic never
 * arrives as tofu, and there is no second rendering pipeline to keep in step with the screen. A native
 * PDF binary (pdfkit) was measured and works, but it would mean shipping an Arabic font file and
 * re-implementing the layout in millimetres for a document whose only consumer is a printer.
 *
 * Two audiences, one page: on screen it is a table a supervisor can read and export; on paper it is a
 * sheet that names the trip, the vehicle, the driver and every passenger with what they paid.
 */
export const dynamic = 'force-dynamic';

function statusKey(status: string): TranslationKey {
  const known = ['accepted', 'pending', 'cancelledByPassenger', 'cancelledByOperator'];
  return `bookings.status.${known.includes(status) ? status : 'accepted'}` as TranslationKey;
}

function paymentKey(status: string): TranslationKey {
  return `bookings.payment.${status}` as TranslationKey;
}

function PassengerTable({
  locale,
  passengers,
  t,
}: {
  readonly locale: Locale;
  readonly passengers: readonly ManifestPassenger[];
  readonly t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}) {
  return (
    <table className="manifest__table">
      <thead>
        <tr>
          <th scope="col">{t('ops.tripCode')}</th>
          <th scope="col">{t('ops.passenger')}</th>
          <th scope="col">{t('ops.phone')}</th>
          <th scope="col">{t('ops.seats')}</th>
          <th scope="col">{t('ops.payment')}</th>
          <th scope="col">{t('ops.total')}</th>
        </tr>
      </thead>
      <tbody>
        {passengers.map((passenger) => (
          <tr key={passenger.code}>
            <td dir="ltr">{passenger.code}</td>
            <td>
              {passenger.name}
              {passenger.note ? <span className="manifest__note"> · {passenger.note}</span> : null}
            </td>
            <td dir="ltr">{passenger.phone}</td>
            <td>{passenger.seats}</td>
            <td>
              {t(paymentKey(passenger.paymentStatus))}
              <span className="manifest__note"> · {t(statusKey(passenger.status))}</span>
            </td>
            <td className="manifest__num">{formatMinor(passenger.totalYer, 'YER', { locale })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function ManifestPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale: raw, id } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const account = await loadAccountContext();
  if (account.configured && !account.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/staff/trips/${id}/manifest`);
  }

  const loaded = await loadManifest(id);
  if (!loaded.ok) {
    return (
      <>
        <SiteHeader locale={locale} pathname="/staff" />
        <main id="main" className="shell narrow">
          <h1>{loaded.reason === 'FORBIDDEN' ? t('ops.outOfScope') : t('ops.notFound')}</h1>
          <p>{loaded.reason === 'FORBIDDEN' ? t('ops.outOfScopeBody') : t('ops.notFoundBody')}</p>
          <Link className="btn btn--ghost" href={`/${locale}/staff/scan`}>
            {t('ops.scan')}
          </Link>
        </main>
      </>
    );
  }

  const { manifest } = loaded;
  const { trip, stops } = manifest;
  const origin = locale === 'ar' ? trip.origin : (trip.originEn ?? trip.origin);
  const destination = locale === 'ar' ? trip.destination : (trip.destinationEn ?? trip.destination);
  const when = departureLabel(trip.departureAt, locale);
  const columns = manifestColumns(manifest.passengers);
  const otherLocale = locale === 'ar' ? 'en' : 'ar';
  const csvHref = `/api/staff/trips/${trip.id}/manifest?locale=${locale}`;

  return (
    <>
      <SiteHeader locale={locale} pathname="/staff" />
      <main id="main" className="shell manifest">
        {/* Screen-only chrome: printing a toolbar is how a manifest becomes a two-page document. */}
        <div className="manifest__bar no-print">
          <Link className="btn btn--ghost" href={`/${locale}/staff/trips/${trip.id}`}>
            {t('ops.trip')}
          </Link>
          <Link
            className="btn btn--ghost"
            href={`/${locale}/staff/trips/${trip.id}/manifest?lang=${otherLocale}`}
            hrefLang={otherLocale}
            lang={otherLocale}
          >
            {otherLocale === 'ar' ? 'العربية' : 'English'}
          </Link>
          <a className="btn btn--ghost" href={csvHref} download>
            {t('ops.csv')}
          </a>
          <PrintButton label={t('ops.manifestPrint')} />
          <span className="form-hint">{t('ops.printHint')}</span>
        </div>

        <article className="manifest__sheet" lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
          <header className="manifest__head">
            <div>
              <p className="manifest__eyebrow">{t('common.appName')}</p>
              <h1>{t('ops.manifestTitle')}</h1>
              <p className="manifest__route">
                {origin} → {destination}
              </p>
              <p className="manifest__meta">
                <strong dir="ltr">{trip.code}</strong> · {when.date} · <bdi>{when.time}</bdi>
              </p>
            </div>
            {trip.qrToken ? (
              <TripQr token={trip.qrToken} caption={`${t('ops.qr')} ${trip.code}`} />
            ) : null}
          </header>

          <dl className="manifest__blocks">
            <div>
              <dt>{t('ops.operator')}</dt>
              <dd>{trip.operatorName ?? '—'}</dd>
            </div>
            <div>
              <dt>{t('ops.vehicle')}</dt>
              <dd>
                {trip.vehicleLabel ?? '—'}
                {trip.vehicleSeats ? ` · ${trip.vehicleSeats} ${t('ops.seats')}` : ''}
              </dd>
            </div>
            <div>
              <dt>{t('ops.driver')}</dt>
              <dd>
                {trip.driverName ?? '—'}
                {trip.driverPhone ? (
                  <>
                    {' · '}
                    <bdi dir="ltr">{trip.driverPhone}</bdi>
                  </>
                ) : null}
              </dd>
            </div>
            <div>
              <dt>{t('ops.occupancy')}</dt>
              <dd>
                {t('ops.occupancyValue', {
                  booked: manifest.passengerCount,
                  total: trip.seatsTotal,
                })}
              </dd>
            </div>
          </dl>

          {stops.length > 0 ? (
            <p className="manifest__stops">
              {stops
                .map((stop) => (locale === 'ar' ? stop.nameAr : (stop.nameEn ?? stop.nameAr)) ?? '')
                .filter(Boolean)
                .join(' — ')}
            </p>
          ) : null}

          {manifest.passengers.length === 0 ? (
            <p className="manifest__empty">{t('ops.noPassengers')}</p>
          ) : (
            // The sheet is 210mm by design; on a phone it scrolls in this box rather than widening
            // the document. This is the one table in the app allowed to be wider than the viewport.
            <div className="table-scroll">
              <div
                className={`manifest__columns${columns.length > 1 ? ' manifest__columns--split' : ''}`}
              >
                {columns.map((column, index) => (
                  <PassengerTable key={index} locale={locale} passengers={column} t={t} />
                ))}
              </div>
            </div>
          )}

          <footer className="manifest__foot">
            <span>{t('ops.generated', { when: when.date })}</span>
            <span>{t('ops.passengerCount', { count: manifest.passengerCount })}</span>
          </footer>
        </article>
      </main>
    </>
  );
}

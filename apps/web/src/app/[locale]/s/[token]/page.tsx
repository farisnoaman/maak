import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ID_TYPE_KEY, isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { EmptyState } from '@/components/ui/Feedback';
import { loadAccountContext } from '@/lib/account';
import { loadSharePreview, passengerIdSignedUrl } from '@/lib/bookings';

/**
 * A watermarked preview of one passenger's ID, for the operator the link was created for.
 *
 * Three things make this safer than sending a photograph in a chat:
 *   - the token expires (72 h) and dies when the passenger asks for a new one;
 *   - the audience is the trip's operator, not whoever happens to hold the URL;
 *   - the view is counted and logged, and the watermark repeats the booking code and the viewer's name,
 *     so a screenshot identifies who took it.
 */
export const dynamic = 'force-dynamic';

export default async function ShareTokenPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale: raw, token } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/s/${token}`);
  }

  const preview = await loadSharePreview(token);
  // Minted per render, so the link the operator clicks lives five minutes — long enough to look at the
  // photograph, short enough not to survive a copy-paste into a group chat.
  const photoUrl = preview?.photoPath ? await passengerIdSignedUrl(preview.photoPath) : null;
  const mark = `${preview?.bookingCode ?? ''} · ${loaded.profile?.fullName ?? loaded.user?.email ?? ''}`;

  return (
    <>
      <SiteHeader locale={locale} pathname="/account" />
      <main id="main" className="shell section">
        {!preview ? (
          <EmptyState
            title={t('bookings.shareNotFound')}
            description={t('bookings.shareNotFoundHint')}
            action={
              <Link className="btn btn--primary" href={`/${locale}/operator`}>
                {t('nav.tabConsole')}
              </Link>
            }
          />
        ) : (
          <>
            <h1>{t('bookings.shareTitle')}</h1>
            <p className="form-hint">
              {t('bookings.shareFor', {
                trip: preview.tripCode,
                code: preview.bookingCode,
              })}
            </p>

            <div className="watermark" aria-hidden="true">
              {Array.from({ length: 12 }, (_, index) => (
                <span key={index}>{mark}</span>
              ))}
            </div>

            <dl className="trip-summary">
              <div className="trip-summary__row">
                <dt>{t('bookings.passenger')}</dt>
                <dd>{preview.passengerName}</dd>
              </div>
              <div className="trip-summary__row">
                <dt>{t('bookings.contactPhone')}</dt>
                <dd dir="ltr">{preview.contactPhone}</dd>
              </div>
              <div className="trip-summary__row">
                <dt>{t('bookings.identityTitle')}</dt>
                <dd>
                  {t(ID_TYPE_KEY[preview.idType ?? 'other'] ?? 'bookings.id.other')} ·{' '}
                  <bdi dir="ltr">{preview.idNumber ?? '—'}</bdi>
                </dd>
              </div>
              {preview.birthPlace ? (
                <div className="trip-summary__row">
                  <dt>{t('bookings.birthPlace')}</dt>
                  <dd>{preview.birthPlace}</dd>
                </div>
              ) : null}
            </dl>

            {preview.photoPath ? (
              <p>
                <a href={photoUrl ?? '#'} target="_blank" rel="noreferrer">
                  {t('bookings.viewIdPhoto')}
                </a>
              </p>
            ) : null}

            <p className="trip-form__hint">
              {t('bookings.shareExpiry', {
                date: new Date(preview.expiresAt).toLocaleDateString(
                  locale === 'ar' ? 'ar-YE' : 'en-GB',
                  { dateStyle: 'medium' },
                ),
                views: preview.views,
              })}
            </p>
          </>
        )}
      </main>
    </>
  );
}

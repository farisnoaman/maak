import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { EmptyState } from '@/components/ui/Feedback';
import { LiveTripPanel } from '@/components/trips/LiveTripPanel';
import { loadTripProgress } from '@/lib/tracking';

/**
 * Where the vehicle is, for the people allowed to know.
 *
 * The visibility question belongs to `get_trip_progress()` — a booking, a driver assignment or an
 * operator membership — so this page renders three honest states instead of second-guessing it:
 * signed out (sign in), signed in but not a passenger (say so), and allowed (live panel).
 *
 * A public trip's page links here, and clicking it as a stranger lands on the third state rather than a
 * 404: "tracking is for booked passengers" is a fact worth stating, and a 404 would suggest the trip
 * does not exist.
 */
export const dynamic = 'force-dynamic';

export default async function LiveTripPage({
  params,
}: {
  params: Promise<{ locale: string; code: string }>;
}) {
  const { locale: raw, code } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  // The authorisation is `get_trip_progress` itself — a booking, a driver assignment or an operator
  // membership. Reading the public trip here would only re-ask a question nobody is allowed to see the
  // answer to, so the page does not.
  const progress = await loadTripProgress(code);

  if (progress.ok === false && progress.code === 'NOT_FOUND') notFound();

  const signedOut = progress.ok === false && progress.code === 'UNAUTHENTICATED';

  return (
    <>
      <SiteHeader locale={locale} pathname="/trips" />
      <main id="main" className="shell section">
        <Link className="trip-back" href={`/${locale}/trips/${code}`}>
          ← {t('common.back')}
        </Link>
        <h1>{t('live.title')}</h1>
        <p className="trip-form__hint">{code}</p>

        {signedOut ? (
          <EmptyState
            title={t('live.signIn')}
            description={t('live.signInBody')}
            action={
              <Link
                className="ui-btn ui-btn--primary ui-btn--md"
                href={`/${locale}/auth/sign-in?next=/${locale}/trips/${code}/live`}
              >
                {t('auth.signIn')}
              </Link>
            }
          />
        ) : progress.ok ? (
          <LiveTripPanel locale={locale} code={code} initial={progress.snapshot} />
        ) : (
          <EmptyState
            title={t('live.notAllowed')}
            description={t('live.signInBody')}
            action={
              <Link className="ui-btn ui-btn--ghost ui-btn--md" href={`/${locale}/trips`}>
                {t('trips.search.title')}
              </Link>
            }
          />
        )}
      </main>
    </>
  );
}

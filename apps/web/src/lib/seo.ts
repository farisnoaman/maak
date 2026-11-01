import type { Metadata } from 'next';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import type { PublicTripDetail } from './trips';

/**
 * Public-page metadata.
 *
 * The marketplace is the only part of the product a search engine should index, and it is indexed in
 * two directions: an Arabic page and an English page of the *same* trip are alternates of each other,
 * not duplicates. Everything here is derived from the data the page already rendered — a canonical URL
 * that disagrees with what a visitor sees is worse than no canonical at all.
 */

/** Absolute origin. `NEXT_PUBLIC_SITE_URL` in production; localhost otherwise, never a guessed domain. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);

export function canonical(path: string): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The canonical URL of *this* locale's page, plus the `hreflang` cluster it belongs to.
 *
 * Canonicalising the English page to the Arabic URL would tell the crawler that the English page is a
 * duplicate and should be dropped — the opposite of what a bilingual marketplace wants.
 */
export function localeAlternates(
  locale: Locale,
  path: string,
): NonNullable<Metadata['alternates']> {
  const suffix = path === '' ? '' : path.startsWith('/') ? path : `/${path}`;
  return {
    canonical: canonical(`/${locale}${suffix}`),
    languages: {
      ar: canonical(`/ar${suffix}`),
      en: canonical(`/en${suffix}`),
      'x-default': canonical(`/ar${suffix}`),
    },
  };
}

export function tripsMetadata(locale: Locale): Metadata {
  const t = (key: TranslationKey) => translate(locale, key);
  return {
    title: `${t('trips.search.title')} — ${t('common.appName')}`,
    description: t('trips.search.subtitle'),
    alternates: localeAlternates(locale, '/trips'),
    openGraph: {
      type: 'website',
      title: t('trips.search.title'),
      description: t('trips.search.subtitle'),
      url: canonical(`/${locale}/trips`),
      locale: locale === 'ar' ? 'ar_YE' : 'en_US',
    },
  };
}

export function tripMetadata(locale: Locale, trip: PublicTripDetail | null): Metadata {
  const t = (key: TranslationKey) => translate(locale, key);
  if (!trip) {
    return { title: t('common.appName'), robots: { index: false, follow: false } };
  }

  const route = `${trip.origin.name} → ${trip.destination.name}`;
  const description =
    locale === 'ar'
      ? `${route} · ${trip.code} · ${trip.seatsAvailable} مقعدًا متاحًا · ${trip.vehicle?.label ?? ''}`.trim()
      : `${route} · ${trip.code} · ${trip.seatsAvailable} seats available · ${trip.vehicle?.label ?? ''}`.trim();

  return {
    title: `${route} — ${t('common.appName')}`,
    description,
    alternates: localeAlternates(locale, `/trips/${trip.code}`),
    robots: trip.hasDeparted ? { index: false, follow: true } : undefined,
    openGraph: {
      type: 'article',
      title: route,
      description,
      url: canonical(`/${locale}/trips/${trip.code}`),
      locale: locale === 'ar' ? 'ar_YE' : 'en_US',
    },
  };
}

/**
 * The trip as `schema.org/BusTrip`.
 *
 * Prices are the ones the RPC computed (`fare.totalMinor`), and `YER` has no minor unit, so the integer
 * is already the major amount — dividing by 100 here would advertise a hundredth of the real fare.
 */
export function tripJsonLd(locale: Locale, trip: PublicTripDetail): Record<string, unknown> {
  const url = canonical(`/${locale}/trips/${trip.code}`);
  const soldOut = trip.seatsAvailable <= 0 || trip.hasDeparted;

  return {
    '@context': 'https://schema.org',
    '@type': 'BusTrip',
    name: `${trip.origin.name} → ${trip.destination.name}`,
    url,
    inLanguage: locale === 'ar' ? 'ar-YE' : 'en-US',
    departureTime: trip.departureAt,
    tripOrigin: { '@type': 'Place', name: trip.origin.name },
    tripDestination: { '@type': 'Place', name: trip.destination.name },
    provider: trip.operator?.name
      ? { '@type': 'Organization', name: trip.operator.name }
      : undefined,
    itinerary: trip.stops.map((stop) => ({
      '@type': 'TouristAttraction',
      name: stop.name,
    })),
    ...(trip.fare
      ? {
          offers: {
            '@type': 'Offer',
            price: trip.fare.totalMinor,
            priceCurrency: trip.fare.currency || 'YER',
            availability: soldOut ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
            url,
          },
        }
      : {}),
  };
}

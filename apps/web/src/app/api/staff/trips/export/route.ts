import { NextResponse } from 'next/server';
import { isLocale, staffTripsCsv } from '@maak/core';
import { loadAccountContext } from '@/lib/account';
import { loadStaffTrips } from '@/lib/trips';

/**
 * The history export.
 *
 * Reads the same `staff_search_trips` the page reads, with the same filters from the query string, so the
 * file and the table cannot disagree. Scope lives in the function; this route never widens it.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const localeParam = url.searchParams.get('locale') ?? 'ar';
  const locale = isLocale(localeParam) ? localeParam : 'ar';

  const account = await loadAccountContext();
  if (account.configured && !account.user) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }

  const list = (name: string) => url.searchParams.getAll(name).filter(Boolean);
  const result = await loadStaffTrips(account.user?.id ?? '', {
    status: list('status'),
    verificationStatus: list('verification'),
    q: url.searchParams.get('q') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
    governorateId: url.searchParams.get('gov') ?? undefined,
  });

  if (result.error) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(staffTripsCsv(result.items, locale), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="trips-${stamp}-${locale}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

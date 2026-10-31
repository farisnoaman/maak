import { NextResponse } from 'next/server';
import { fleetCostCsv, fleetCsv, fleetFilename, isLocale } from '@maak/core';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import { loadFleetCostDetail, loadFleetSummary, toExportRows } from '@/lib/fleet-ops';

/** `YYYY-MM-DD` or nothing. A date the browser half-sent is not a range, so it is ignored, not guessed. */
function isoDay(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/**
 * The fleet export.
 *
 * Reads the same `fleet_summary` the page renders, for the same context, so the spreadsheet and the table
 * cannot disagree — the acceptance criterion for the phase is that the totals reconcile with the logs, and
 * an export that re-summed them itself would be the one place they could stop doing so.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const localeParam = url.searchParams.get('locale') ?? 'ar';
  const locale = isLocale(localeParam) ? localeParam : 'ar';

  const account = await loadAccountContext();
  if (account.configured && !account.user) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }

  const org = account.configured
    ? activeOrganization(account, url.searchParams.get('org') ?? undefined)
    : null;
  // `kind=detail` is the ledger: one row per fill and per service, in a date window. The default stays the
  // per-vehicle rollup, so the existing link and its bookmark keep working.
  if (url.searchParams.get('kind') === 'detail') {
    const from = isoDay(url.searchParams.get('from'));
    const to = isoDay(url.searchParams.get('to'));
    const ledger = await loadFleetCostDetail(account, org?.id ?? null, from, to);
    const name = `maak-fleet-costs-${ledger.range.from || 'start'}_${ledger.range.to || 'today'}.csv`;
    return new NextResponse(fleetCostCsv(ledger.rows, locale), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      },
    });
  }

  const summary = await loadFleetSummary(account, org?.id ?? null);

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(fleetCsv(toExportRows(summary.vehicles), locale), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${fleetFilename(stamp)}"`,
      'cache-control': 'no-store',
    },
  });
}

import { NextResponse } from 'next/server';
import { fleetCsv, fleetFilename, isLocale } from '@maak/core';
import { activeOrganization, loadAccountContext } from '@/lib/account';
import { loadFleetSummary, toExportRows } from '@/lib/fleet-ops';

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

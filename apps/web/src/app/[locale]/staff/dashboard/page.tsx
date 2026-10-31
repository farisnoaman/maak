import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { formatDateTime, isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { loadAccountContext } from '@/lib/account';
import { loadStaffSummary } from '@/lib/staff-ops';
import { loadStaffTrips } from '@/lib/trips';
import { BulkVerifyPanel } from '@/components/staff/BulkVerifyPanel';

/**
 * The supervisor's dashboard.
 *
 * Four numbers and a queue, in one server render: pending work in the patch, trips running, the ones
 * that have gone quiet, and the last ten scans this person made. The queue underneath is the bulk
 * action — a supervisor who reviews one trip at a time at a checkpoint queue will stop using the tool.
 */
export const dynamic = 'force-dynamic';

export default async function StaffDashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const account = await loadAccountContext();
  if (account.configured && !account.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/staff/dashboard`);
  }

  const summary = await loadStaffSummary();
  const queue = account.user
    ? await loadStaffTrips(account.user.id, { status: ['pending'] })
    : { configured: false, items: [] };

  return (
    <>
      <SiteHeader locale={locale} pathname="/staff" />
      <ConsoleShell
        locale={locale}
        title="ops.dashboardTitle"
        subtitle="console.subtitle.staff"
        phase="7"
        items={[
          { key: 'console.navOverview', href: `/${locale}/staff` },
          { key: 'ops.dashboard', href: `/${locale}/staff/dashboard` },
          { key: 'ops.scan', href: `/${locale}/staff/scan` },
          { key: 'staff.trips.title', href: `/${locale}/staff/trips` },
        ]}
      >
        {!summary ? (
          <EmptyState
            title={t('staff.empty')}
            description={t('errors.FORBIDDEN')}
            action={
              <Link className="btn btn--ghost" href={`/${locale}/staff`}>
                {t('ops.backToStaff')}
              </Link>
            }
          />
        ) : (
          <>
            <div className="stat-grid">
              <div className="stat">
                <span className="stat__label">{t('ops.pending')}</span>
                <strong className="stat__value">{summary.pendingTrips}</strong>
              </div>
              <div className="stat">
                <span className="stat__label">{t('ops.live')}</span>
                <strong className="stat__value">{summary.liveTrips}</strong>
              </div>
              <div className="stat">
                <span className="stat__label">{t('ops.stale')}</span>
                <strong className="stat__value">{summary.staleTrips}</strong>
              </div>
              <div className="stat">
                <span className="stat__label">{t('ops.scope')}</span>
                <strong className="stat__value stat__value--text">
                  {summary.global
                    ? t('ops.scopeGlobal')
                    : t('ops.scopeCount', { count: summary.governorates.length })}
                </strong>
              </div>
            </div>

            <BulkVerifyPanel locale={locale} trips={queue.items} />

            <section className="card ops-recent">
              <h2>{t('ops.recentScans')}</h2>
              {summary.recentScans.length === 0 ? (
                <p className="form-hint">{t('ops.noScans')}</p>
              ) : (
                <ul className="ops-scanlist">
                  {summary.recentScans.map((scan, index) => (
                    <li key={`${scan.at}-${index}`}>
                      <span className={scan.allowed ? 'ops-ok' : 'ops-deny'}>
                        {scan.allowed ? '✓' : '✕'}
                      </span>
                      <span>{scan.code ?? '—'}</span>
                      <span className="form-hint">
                        {scan.reason ?? ''} {formatDateTime(scan.at, { locale })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </ConsoleShell>
    </>
  );
}

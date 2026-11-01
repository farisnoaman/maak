import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { formatDateTime, isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { ConsoleShell } from '@/components/ConsoleShell';
import { EmptyState } from '@/components/ui/Feedback';
import { staffNav } from '@/components/staff/StaffNav';
import { loadAccountContext } from '@/lib/account';
import { callGateway } from '@/lib/gateway';
import { loadGovernorateOptions, loadStaffSummary } from '@/lib/staff-ops';
import { loadStaffTrips } from '@/lib/trips';
import { BulkVerifyPanel } from '@/components/staff/BulkVerifyPanel';

/**
 * The supervisor's dashboard.
 *
 * It was four zeroes and two empty boxes: `pending 0 / live 0 / stale 0 / scope 3`, with no link to the thing each
 * number counted, no way to tell "nothing is waiting" from "nothing loaded", and no clue how fresh any of it was —
 * on the one screen whose entire job is *what needs me now*.
 *
 * Now: a clear statement at the top when the queues are empty (a supervisor's best-case morning), each figure a
 * door into the queue behind it, the patch named rather than counted, and the time the numbers were read.
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

  const [summary, governorates, queue, verificationQueue] = await Promise.all([
    loadStaffSummary(),
    loadGovernorateOptions(),
    account.user
      ? loadStaffTrips(account.user.id, { status: ['pending'] })
      : Promise.resolve({ configured: false, items: [] }),
    // The account/company queue, counted the same way the queue page reads it — one call, and `null` rather than
    // `0` when it cannot be read, because "nothing is waiting" and "we could not ask" are different answers.
    callGateway<{ items: readonly unknown[] }>('verification-queue', {
      action: 'queue.list',
      status: 'pending',
      subjectType: 'all',
      limit: 50,
    }),
  ]);

  const pendingVerifications = verificationQueue.ok ? verificationQueue.data.items.length : null;

  const scopeNames = summary?.global
    ? []
    : (summary?.governorates ?? []).map((id) => {
        const governorate = governorates.find((option) => option.id === id);
        // The patch is read by the same person in two languages; a list that stays Arabic in English is a bug.
        return governorate
          ? locale === 'ar'
            ? governorate.nameAr
            : (governorate.nameEn ?? governorate.nameAr)
          : id;
      });

  const figures: {
    key: TranslationKey;
    value: number | null;
    href: string;
    tone?: 'warning' | 'danger';
  }[] = summary
    ? [
        {
          key: 'ops.pending',
          value: summary.pendingTrips,
          href: `/${locale}/staff/trips`,
          tone: summary.pendingTrips > 0 ? 'warning' : undefined,
        },
        {
          key: 'ops.verificationPending',
          value: pendingVerifications,
          href: `/${locale}/staff/verifications`,
          tone: pendingVerifications ? 'warning' : undefined,
        },
        {
          key: 'ops.live',
          value: summary.liveTrips,
          href: `/${locale}/staff/trips?status=published`,
        },
        {
          key: 'ops.stale',
          value: summary.staleTrips,
          href: `/${locale}/staff/trips?status=published`,
          tone: summary.staleTrips > 0 ? 'danger' : undefined,
        },
      ]
    : [];

  return (
    <>
      <SiteHeader locale={locale} pathname="/staff/dashboard" />
      <ConsoleShell
        locale={locale}
        title="ops.dashboardTitle"
        consoleTitle="console.staff"
        subtitle="ops.dashboardSubtitle"
        pathname="/staff/dashboard"
        groups={staffNav(locale)}
        actions={
          <span className="console-panel__stamp">
            {t('ops.asOf', { time: formatDateTime(new Date().toISOString(), { locale }) })}
          </span>
        }
      >
        {!summary ? (
          <EmptyState
            title={t('staff.empty')}
            description={t('ops.noSummaryBody')}
            action={
              <Link className="btn btn--ghost" href={`/${locale}/staff`}>
                {t('ops.backToStaff')}
              </Link>
            }
          />
        ) : (
          <>
            {/* The clear state is information. A supervisor who sees four zeroes should be told what that means. */}
            {summary.pendingTrips === 0 &&
            summary.staleTrips === 0 &&
            queue.items.length === 0 &&
            (pendingVerifications ?? 0) === 0 ? (
              <p className="ops-clear" role="status">
                <span className="ops-clear__tick" aria-hidden="true">
                  ✓
                </span>
                {t('ops.allClear')}
              </p>
            ) : null}

            <div className="stat-grid stat-grid--links">
              {figures.map((figure) => (
                <Link
                  className={`stat stat--link${figure.tone ? ` stat--${figure.tone}` : ''}`}
                  href={figure.href}
                  key={figure.key}
                >
                  <span className="stat__label">{t(figure.key)}</span>
                  {/* An em dash when the count could not be read — never a zero it cannot vouch for. */}
                  <strong className="stat__value">{figure.value ?? '—'}</strong>
                  <span className="stat__go route-arrow" aria-hidden="true">
                    →
                  </span>
                </Link>
              ))}
              <div className="stat">
                <span className="stat__label">{t('ops.scope')}</span>
                {summary.global ? (
                  <strong className="stat__value stat__value--text">{t('ops.scopeGlobal')}</strong>
                ) : (
                  <strong className="stat__value stat__value--text">
                    {t('ops.scopeCount', { count: summary.governorates.length })}
                  </strong>
                )}
                {/* A count of three is not a patch; the names are. */}
                {scopeNames.length > 0 ? (
                  <span className="stat__note">{scopeNames.join(' · ')}</span>
                ) : null}
              </div>
            </div>

            {/* The panel carries its own heading and card, so it is not wrapped in another section — that is how
                the page ended up with two titles stacked on each other. */}
            <BulkVerifyPanel locale={locale} trips={queue.items} />

            <section className="ops-section" aria-labelledby="ops-recent">
              <div className="ops-section__head">
                <h2 id="ops-recent">{t('ops.recentScans')}</h2>
                <Link className="link-more" href={`/${locale}/staff/scan`}>
                  {t('ops.scan')}
                </Link>
              </div>
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

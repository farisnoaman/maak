'use client';

import { useState } from 'react';
import { formatDate, formatMinor, translate, type Locale, type TranslationKey } from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import type { PlanRow, QuotaOverrideRow, SubscriptionView } from '@/lib/finance';
import { FinanceAlert, useFinanceCommand } from './useFinanceCommand';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  trialing: 'info',
  active: 'success',
  past_due: 'warning',
  grace: 'danger',
  cancelled: 'neutral',
  expired: 'neutral',
};

/**
 * The operator's billing panel.
 *
 * It shows the plan the *database* resolved (`app.owner_plan`) rather than what the operator picked,
 * because those differ during a trial, while past due, and after an expiry fell back to Basic. The screens
 * that say "you are on Pro" from a client copy of the plan are the ones that get billing wrong.
 *
 * The upgrade button bills the prorated difference and takes effect immediately; a downgrade is scheduled
 * for the end of the paid period, and the screen says so instead of pretending the change already happened.
 */
export function BillingPanel({
  locale,
  orgId,
  subscription,
  plan,
  plans,
  quota,
  overrides,
}: {
  readonly locale: Locale;
  readonly orgId: string | null;
  readonly subscription: SubscriptionView | null;
  readonly plan: 'basic' | 'pro' | 'business' | null;
  readonly plans: readonly PlanRow[];
  readonly quota: readonly { metric: string; limit: number | null; used: number }[];
  readonly overrides: readonly QuotaOverrideRow[];
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, run } = useFinanceCommand(locale);
  const [target, setTarget] = useState<string>('pro');
  const [reason, setReason] = useState('');

  const paidPlans = plans.filter((item) => item.priceYer > 0);
  const selected = plans.find((item) => item.code === target) ?? paidPlans[0];

  return (
    <div className="billing">
      <FinanceAlert message={message} />

      <section>
        <h2>{t('billing.title')}</h2>
        <dl className="finance-summary">
          <div className="finance-summary__row">
            <dt>{t('billing.plan')}</dt>
            <dd>{t(`plan.${plan ?? 'basic'}` as TranslationKey)}</dd>
          </div>
          {subscription ? (
            <>
              <div className="finance-summary__row">
                <dt>{t('billing.status')}</dt>
                <dd>
                  <Badge tone={STATUS_TONE[subscription.status] ?? 'neutral'}>
                    {t(`sub.status.${subscription.status}` as TranslationKey)}
                  </Badge>
                </dd>
              </div>
              <div className="finance-summary__row">
                <dt>{t('billing.price')}</dt>
                <dd>{formatMinor(subscription.priceYer, 'YER', { locale })}</dd>
              </div>
              <div className="finance-summary__row">
                <dt>{t('billing.period')}</dt>
                <dd>
                  {formatDate(subscription.currentPeriodStart, { locale })} →{' '}
                  {formatDate(subscription.currentPeriodEnd, { locale })}
                </dd>
              </div>
              {subscription.trialEndsAt ? (
                <div className="finance-summary__row">
                  <dt>{t('billing.trialEnds')}</dt>
                  <dd>{formatDate(subscription.trialEndsAt, { locale })}</dd>
                </div>
              ) : null}
              {subscription.pendingPlanCode ? (
                <div className="finance-summary__row">
                  <dt>{t('billing.scheduled')}</dt>
                  <dd>{t(`plan.${subscription.pendingPlanCode}` as TranslationKey)}</dd>
                </div>
              ) : null}
              {subscription.cancelAtPeriodEnd ? (
                <div className="finance-summary__row">
                  <dt>{t('billing.cancel')}</dt>
                  <dd>{t('billing.cancelled')}</dd>
                </div>
              ) : null}
            </>
          ) : (
            <div className="finance-summary__row">
              <dt>{t('billing.status')}</dt>
              <dd>{t('billing.noSubscription')}</dd>
            </div>
          )}
        </dl>
      </section>

      <section>
        <h2>{subscription ? t('billing.changePlan') : t('billing.start')}</h2>
        <Select
          label={t('billing.plan')}
          value={target}
          options={paidPlans.map((item) => ({
            value: item.code,
            label: `${t(`plan.${item.code}` as TranslationKey)} · ${formatMinor(
              item.priceYer,
              'YER',
              {
                locale,
              },
            )}`,
          }))}
          onChange={(event) => setTarget(event.target.value)}
        />
        <p className="form-hint">
          {t('billing.price')}: {selected ? formatMinor(selected.priceYer, 'YER', { locale }) : '—'}
        </p>

        {subscription ? (
          <div className="finance-desk__actions">
            <Button
              loading={busy}
              onClick={() =>
                void run({
                  action: 'subscription.changePlan',
                  subscriptionId: subscription.id,
                  planCode: target as never,
                  when: 'now',
                })
              }
            >
              {t('billing.changeNow')}
            </Button>
            <Button
              variant="ghost"
              loading={busy}
              onClick={() =>
                void run({
                  action: 'subscription.changePlan',
                  subscriptionId: subscription.id,
                  planCode: target as never,
                  when: 'period_end',
                })
              }
            >
              {t('billing.changeAtEnd')}
            </Button>
          </div>
        ) : (
          <Button
            loading={busy}
            onClick={() =>
              void run({
                action: 'subscription.start',
                orgId,
                ownerUserId: null,
                planCode: target as never,
                trial: true,
              })
            }
          >
            {t('billing.start')}
          </Button>
        )}
      </section>

      {subscription && !subscription.cancelAtPeriodEnd ? (
        <section>
          <h2>{t('billing.cancel')}</h2>
          <label className="ui-field__label" htmlFor="cancel-reason">
            {t('ledger.reason')}
          </label>
          <input
            id="cancel-reason"
            className="ui-input"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            variant="danger"
            loading={busy}
            disabled={reason.trim().length < 5}
            onClick={() =>
              void run({
                action: 'subscription.cancel',
                subscriptionId: subscription.id,
                atPeriodEnd: true,
                reason: reason.trim(),
              })
            }
          >
            {t('billing.cancel')}
          </Button>
          <p className="form-hint">{t('billing.cancelled')}</p>
        </section>
      ) : null}

      <section>
        <h2>{t('billing.quota')}</h2>
        <div className="table-scroll">
          <table className="data-table table-cards">
            <caption className="visually-hidden">{t('billing.quota')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('plans.metric')}</th>
                <th scope="col">{t('billing.used')}</th>
                <th scope="col">{t('billing.limit')}</th>
              </tr>
            </thead>
            <tbody>
              {quota.map((row) => {
                const override = overrides.find((item) => item.metric === row.metric);
                return (
                  <tr key={row.metric}>
                    <th scope="row" data-label={t('plans.metric')}>
                      {t(`metric.${row.metric}` as TranslationKey)}
                    </th>
                    <td data-label={t('billing.used')}>{row.used}</td>
                    <td data-label={t('billing.limit')}>
                      {row.limit === null ? t('billing.unlimited') : row.limit}
                      {override?.expiresAt
                        ? ` · ${t('billing.overrideUntil', { date: formatDate(override.expiresAt, { locale }) })}`
                        : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

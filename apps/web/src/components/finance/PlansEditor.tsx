'use client';

import { useState } from 'react';
import { formatDate, formatMinor, translate, type Locale, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import type { CommissionRuleRow, PlanRow } from '@/lib/finance';
import { FinanceAlert, useFinanceCommand } from './useFinanceCommand';

const METRICS = [
  'vehicles',
  'drivers',
  'staff',
  'trips',
  'active_trips',
  'featured_listings',
  'fleet_reports',
  'finance_exports',
] as const;

/** A blank limit means unlimited — null, not zero. Zero would mean "not allowed", which is a real limit. */
function parseLimit(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/**
 * The pricing screen.
 *
 * Plans and commission rates are rows, not code, so an admin can move a price without a deploy. The two
 * editors share this file because they are the same decision seen twice: what a plan costs and what the
 * platform keeps from what it earns. The commission form says how the effective rate is composed
 * (global → plan discount → floor → caps) because a rule that silently loses to another rule is how a
 * merchant ends up arguing about money.
 */
export function PlansEditor({
  locale,
  plans,
  rules,
}: {
  readonly locale: Locale;
  readonly plans: readonly PlanRow[];
  readonly rules: readonly CommissionRuleRow[];
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, done, run } = useFinanceCommand(locale);
  const [editing, setEditing] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [trial, setTrial] = useState('');
  const [limits, setLimits] = useState<Record<string, string>>({});

  const [ruleOrg, setRuleOrg] = useState<string>('');
  const [basisPoints, setBasisPoints] = useState('');
  const [minYer, setMinYer] = useState('');
  const [maxYer, setMaxYer] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [note, setNote] = useState('');

  function startEdit(plan: PlanRow) {
    setEditing(plan.code);
    setPrice(String(plan.priceYer));
    setTrial(String(plan.trialDays));
    setLimits(
      Object.fromEntries(
        METRICS.map((metric) => [
          metric,
          plan.limits[metric] === null ? '' : String(plan.limits[metric]),
        ]),
      ),
    );
  }

  return (
    <div className="plans">
      <FinanceAlert message={message} />
      {done ? (
        <p className="ui-alert" role="status">
          {t('plans.saved')}
        </p>
      ) : null}

      <section>
        <h2>{t('plans.priceList')}</h2>
        <div className="table-scroll">
          <table className="data-table table-cards">
            <caption className="visually-hidden">{t('plans.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('billing.plan')}</th>
                <th scope="col">{t('plans.price')}</th>
                <th scope="col">{t('plans.trialDays')}</th>
                <th scope="col">{t('plans.metric')}</th>
                <th scope="col">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.code}>
                  <th scope="row" data-label={t('billing.plan')}>
                    {t(`plan.${plan.code}` as TranslationKey)}
                  </th>
                  <td data-label={t('plans.price')}>
                    {formatMinor(plan.priceYer, 'YER', { locale })}
                  </td>
                  <td data-label={t('plans.trialDays')}>{plan.trialDays}</td>
                  <td data-label={t('plans.metric')}>
                    {METRICS.filter((metric) => plan.limits[metric] !== undefined)
                      .map(
                        (metric) =>
                          `${t(`metric.${metric}` as TranslationKey)} ${
                            plan.limits[metric] === null
                              ? t('plans.unlimited')
                              : plan.limits[metric]
                          }`,
                      )
                      .join(' · ')}
                  </td>
                  <td data-label={t('common.actions')}>
                    <Button size="sm" variant="subtle" onClick={() => startEdit(plan)}>
                      {t('plans.edit')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {editing ? (
          <div className="finance-form">
            <h3>{t(`plan.${editing}` as TranslationKey)}</h3>
            <Field
              label={t('plans.price')}
              inputMode="numeric"
              value={price}
              onChange={(event) => setPrice(event.target.value.replace(/[^0-9]/g, ''))}
              hint={`${price === '' ? '0' : price} YER`}
            />
            <Field
              label={t('plans.trialDays')}
              inputMode="numeric"
              value={trial}
              onChange={(event) => setTrial(event.target.value.replace(/[^0-9]/g, ''))}
            />
            {METRICS.map((metric) => (
              <Field
                key={metric}
                label={t(`metric.${metric}` as TranslationKey)}
                inputMode="numeric"
                value={limits[metric] ?? ''}
                placeholder={t('plans.unlimited')}
                onChange={(event) =>
                  setLimits((current) => ({
                    ...current,
                    [metric]: event.target.value.replace(/[^0-9]/g, ''),
                  }))
                }
              />
            ))}
            <div className="finance-desk__actions">
              <Button
                loading={busy}
                onClick={() =>
                  void run({
                    action: 'plan.update',
                    code: editing as never,
                    priceYer: Number(price || '0'),
                    trialDays: Number(trial || '0'),
                    limits: Object.fromEntries(
                      METRICS.map((metric) => [metric, parseLimit(limits[metric] ?? '')]),
                    ),
                  })
                }
              >
                {t('plans.save')}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section>
        <h2>{t('plans.commissions')}</h2>
        <p className="form-hint">{t('plans.commissionHelp')}</p>

        <div className="finance-form">
          <Field
            label={t('subs.orgId')}
            value={ruleOrg}
            onChange={(event) => setRuleOrg(event.target.value.trim())}
            hint={t('plans.commissionHelp')}
          />
          <Field
            label={t('plans.basisPoints')}
            inputMode="numeric"
            value={basisPoints}
            onChange={(event) => setBasisPoints(event.target.value.replace(/[^0-9]/g, ''))}
            hint={`${basisPoints === '' ? '0' : basisPoints} bp`}
          />
          <Field
            label={t('plans.minYer')}
            inputMode="numeric"
            value={minYer}
            onChange={(event) => setMinYer(event.target.value.replace(/[^0-9]/g, ''))}
          />
          <Field
            label={t('plans.maxYer')}
            inputMode="numeric"
            value={maxYer}
            onChange={(event) => setMaxYer(event.target.value.replace(/[^0-9]/g, ''))}
          />
          <Field
            label={t('plans.effectiveFrom')}
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
          <Field
            label={t('plans.note')}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button
            loading={busy}
            disabled={effectiveFrom === '' || basisPoints === ''}
            onClick={() =>
              void run({
                action: 'commission.rule.save',
                orgId: ruleOrg === '' ? null : ruleOrg,
                ownerUserId: null,
                effectiveTo: null,
                basisPoints: Number(basisPoints),
                minYer: minYer === '' ? null : Number(minYer),
                maxYer: maxYer === '' ? null : Number(maxYer),
                effectiveFrom,
                note: note.trim() === '' ? null : note.trim(),
              })
            }
          >
            {t('plans.addRule')}
          </Button>
        </div>

        {rules.length === 0 ? (
          <p className="form-hint">{t('plans.noRules')}</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table table-cards">
              <caption className="visually-hidden">{t('plans.commissions')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('billing.plan')}</th>
                  <th scope="col">{t('plans.basisPoints')}</th>
                  <th scope="col">{t('plans.minYer')}</th>
                  <th scope="col">{t('plans.maxYer')}</th>
                  <th scope="col">{t('plans.effectiveFrom')}</th>
                  <th scope="col">{t('plans.note')}</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <th scope="row" data-label={t('billing.plan')}>
                      {rule.orgId ?? t('plans.commissions')}
                    </th>
                    <td data-label={t('plans.basisPoints')}>{rule.basisPoints} bp</td>
                    <td data-label={t('plans.minYer')}>
                      {rule.minYer === null ? '—' : formatMinor(rule.minYer, 'YER', { locale })}
                    </td>
                    <td data-label={t('plans.maxYer')}>
                      {rule.maxYer === null ? '—' : formatMinor(rule.maxYer, 'YER', { locale })}
                    </td>
                    <td data-label={t('plans.effectiveFrom')}>
                      {formatDate(rule.effectiveFrom, { locale })}
                    </td>
                    <td data-label={t('plans.note')}>{rule.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

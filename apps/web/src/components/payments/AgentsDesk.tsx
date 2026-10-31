'use client';

import { useState } from 'react';
import { formatMinor, translate, type Locale, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import type { AgentRow } from '@/lib/payments';
import { PaymentAlert, usePaymentCommand } from './usePaymentCommand';

/**
 * Agents and their floats.
 *
 * A cash agent holds the platform's money in a drawer, so the balance they may hold is capped by the
 * credit limit the desk granted them — the command refuses a cash-in that would cross it, and the number
 * shown here is the same one it compares against.
 */
export function AgentsDesk({
  locale,
  agents,
}: {
  readonly locale: Locale;
  readonly agents: readonly AgentRow[];
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);
  const { busy, message, done, run } = usePaymentCommand(locale);
  const [active, setActive] = useState<string | null>(null);
  const [amount, setAmount] = useState('');

  if (agents.length === 0) return <p className="form-hint">{t('financeAgents.empty')}</p>;

  return (
    <div className="agents-desk">
      <PaymentAlert message={message} />
      {done ? (
        <p className="ui-alert" role="status">
          {t('financeAgents.cashInDone')}
        </p>
      ) : null}
      <ul className="payment-queue__list">
        {agents.map((agent) => {
          const room = Math.max(agent.creditLimitYer - agent.floatBalanceYer, 0);
          return (
            <li key={agent.id} className="payment-row">
              <div className="payment-row__head">
                <bdi dir="ltr" className="payment-row__code">
                  {agent.id.slice(0, 8)}
                </bdi>
                <span className="payment-row__meta">{agent.status}</span>
              </div>
              <dl className="payment-row__facts">
                <div>
                  <dt>{t('financeAgents.float')}</dt>
                  <dd>{formatMinor(agent.floatBalanceYer, 'YER', { locale })}</dd>
                </div>
                <div>
                  <dt>{t('financeAgents.limit')}</dt>
                  <dd>{formatMinor(agent.creditLimitYer, 'YER', { locale })}</dd>
                </div>
                <div>
                  <dt>{t('financeAgents.cashIn')}</dt>
                  <dd>{formatMinor(room, 'YER', { locale })}</dd>
                </div>
              </dl>

              {active === agent.id ? (
                <div className="payment-row__decide">
                  <Field
                    label={t('financeAgents.amount')}
                    inputMode="numeric"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value.replace(/[^0-9]/g, ''))}
                    hint={formatMinor(room, 'YER', { locale })}
                  />
                  <div className="form-actions">
                    <Button
                      loading={busy}
                      disabled={Number(amount) <= 0 || Number(amount) > room}
                      onClick={async () => {
                        const result = await run({
                          action: 'agent.cashIn',
                          agentId: agent.id,
                          amountYer: Number(amount),
                          note: null,
                        });
                        if (result) {
                          setActive(null);
                          setAmount('');
                        }
                      }}
                    >
                      {t('financeAgents.cashIn')}
                    </Button>
                    <Button variant="ghost" onClick={() => setActive(null)}>
                      {t('common.cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="subtle" onClick={() => setActive(agent.id)}>
                  {t('financeAgents.cashIn')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

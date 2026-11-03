'use client';

import { useState } from 'react';
import {
  errorKey,
  identityCommandSpec,
  PLATFORM_ROLES,
  translate,
  type Locale,
  type TranslationKey,
} from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { getApiClient } from '@/lib/api';
import { ROLE_LABEL, type AdminUserRow } from './UserDirectory';

/**
 * Granting and revoking platform roles — the write half of `/admin/users`, on its own page.
 *
 * Two things live here because they answer one question. **The control**: pick a person, pick a role, grant or
 * revoke. **The ledger**: for each role, who holds it. Splitting those across two screens would put the audit
 * question ("is anyone the only admin?") somewhere else than the lever that changes the answer.
 *
 * The form starts on the person you arrived with (`?user=`), which is how the directory hands a row over: open the
 * person, then act on them — rather than re-finding them in a select of fifty.
 *
 * The "last admin" rule is enforced by the command, which refuses to demote the only admin. The page says so up
 * front instead of letting someone discover it by locking the platform out.
 */
export function RoleGrants({
  locale,
  users,
  configured,
  initialUserId,
}: {
  readonly locale: Locale;
  readonly users: readonly AdminUserRow[];
  readonly configured: boolean;
  readonly initialUserId?: string;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const named = (user: AdminUserRow) => user.name ?? user.email ?? user.id;

  const startId =
    initialUserId && users.some((user) => user.id === initialUserId)
      ? initialUserId
      : (users[0]?.id ?? '');
  const [rows, setRows] = useState(users);
  const [target, setTarget] = useState(startId);
  const [role, setRole] = useState<string>('platform_staff');
  const [busy, setBusy] = useState<'grant' | 'revoke' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function mutate(action: 'grant' | 'revoke') {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setBusy(action);
    setError(null);
    setMessage(null);

    const result = await client.call(identityCommandSpec, {
      action: action === 'grant' ? 'role.grant' : 'role.revoke',
      userId: target,
      role: role as 'platform_admin',
    });

    setBusy(null);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setRows((current) =>
      current.map((row) =>
        row.id === target
          ? {
              ...row,
              roles:
                action === 'grant'
                  ? Array.from(new Set([...row.roles, role]))
                  : row.roles.filter((existing) => existing !== role),
            }
          : row,
      ),
    );
    setMessage(action === 'grant' ? t('admin.granted') : t('admin.revoked'));
  }

  const selected = rows.find((row) => row.id === target) ?? null;

  return (
    <>
      <section className="console-section">
        <div className="console-section__head">
          <h2>{t('admin.grant')}</h2>
        </div>
        <fieldset className="invite-box">
          <legend>{t('admin.grantOrRevoke')}</legend>
          <div className="form-grid">
            <Select
              label={t('admin.users')}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              options={rows.map((user) => ({
                value: user.id,
                label: named(user),
              }))}
            />
            <Select
              label={t('admin.roles')}
              value={role}
              onChange={(event) => setRole(event.target.value)}
              options={PLATFORM_ROLES.map((candidate) => ({
                value: candidate,
                label: ROLE_LABEL[candidate] ? t(ROLE_LABEL[candidate]!) : candidate,
              }))}
            />
            <Field
              label={t('admin.userId')}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              dir="ltr"
              hint={t('common.optional')}
            />
          </div>

          {selected ? (
            <p className="form-hint" role="status">
              <strong>{named(selected)}</strong>
              {' — '}
              {selected.roles.length === 0
                ? t('admin.noRoles')
                : selected.roles
                    .map((existing) => (ROLE_LABEL[existing] ? t(ROLE_LABEL[existing]!) : existing))
                    .join(' · ')}
            </p>
          ) : null}

          <div className="form-actions">
            <Button onClick={() => mutate('grant')} loading={busy === 'grant'}>
              {t('admin.grant')}
            </Button>
            <Button variant="danger" onClick={() => mutate('revoke')} loading={busy === 'revoke'}>
              {t('admin.revoke')}
            </Button>
          </div>
        </fieldset>

        {message ? (
          <p className="form-success" role="status">
            {message}
          </p>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <section className="console-section">
        <div className="console-section__head">
          <h2>{t('admin.rolesHeld')}</h2>
          <span className="console-section__meta">{rows.length}</span>
        </div>
        <p className="form-hint">{t('admin.rolesHeldHint')}</p>

        <ul className="role-ledger">
          {PLATFORM_ROLES.map((candidate) => {
            const holders = rows.filter((row) => row.roles.includes(candidate));
            return (
              <li className="role-ledger__row" key={candidate}>
                <span className="role-ledger__name">{t(ROLE_LABEL[candidate]!)}</span>
                <span className="role-ledger__count num">{holders.length}</span>
                <span className="role-ledger__holders">
                  {holders.length === 0
                    ? t('admin.rolesNoHolders')
                    : holders.map((holder) => named(holder)).join(' · ')}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

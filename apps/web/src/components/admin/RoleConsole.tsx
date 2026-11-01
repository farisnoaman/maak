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
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { getApiClient } from '@/lib/api';

export interface AdminUserRow {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone?: string | null;
  readonly verification: string;
  readonly roles: readonly string[];
  /** `profiles.deletion_requested_at` is set: the row is one the deletion executor is waiting for. */
  readonly deletionPending?: boolean;
}

const ROLE_LABEL: Record<string, TranslationKey> = {
  platform_admin: 'admin.role.platform_admin',
  platform_staff: 'admin.role.platform_staff',
  finance_officer: 'admin.role.finance_officer',
  geo_supervisor: 'admin.role.geo_supervisor',
};

/**
 * Role administration. Admin-only, and the same screen has to make the "last admin" rule obvious —
 * the command refuses to demote the only admin, so the UI explains it rather than letting someone
 * strip their own access and lock the platform out.
 */
export function RoleConsole({
  locale,
  users,
  configured,
  truncated = false,
}: {
  readonly locale: Locale;
  readonly users: readonly AdminUserRow[];
  readonly configured: boolean;
  /** The read is capped; say so, because a silent cap reads as "this is everyone". */
  readonly truncated?: boolean;
}) {
  const t = (key: TranslationKey) => translate(locale, key);
  const [rows, setRows] = useState(users);
  const [target, setTarget] = useState(users[0]?.id ?? '');
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

  return (
    <div className="card console-panel">
      <h2 style={{ fontSize: '1.05rem' }}>{t('admin.roles')}</h2>
      <p className="form-hint">{truncated ? t('admin.usersCap') : t('admin.usersRecent')}</p>

      <div className="table-scroll" tabIndex={0}>
        <table className="data-table">
          <caption className="visually-hidden">{t('admin.users')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('admin.users')}</th>
              <th scope="col">{t('admin.verification')}</th>
              <th scope="col">{t('admin.roles')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3}>
                  <span className="form-hint">{t('admin.noUsers')}</span>
                </td>
              </tr>
            ) : null}
            {rows.map((user) => (
              <tr key={user.id}>
                <td>
                  <span>{user.name ?? t('admin.deletionUnnamed')}</span>
                  <span className="form-hint" dir="ltr" style={{ display: 'block' }}>
                    {user.email ?? user.phone ?? user.id}
                  </span>
                  {user.deletionPending ? (
                    <Badge tone="warning">{t('admin.deletionPending')}</Badge>
                  ) : null}
                </td>
                <td>
                  <Badge tone={user.verification === 'verified' ? 'success' : 'neutral'}>
                    {t(`verification.status.${user.verification}` as TranslationKey)}
                  </Badge>
                </td>
                <td>
                  {user.roles.length === 0 ? (
                    <span className="form-hint">{t('admin.noRoles')}</span>
                  ) : (
                    <span style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                      {user.roles.map((existing) => (
                        <Badge key={existing} tone="info">
                          {ROLE_LABEL[existing] ? t(ROLE_LABEL[existing]!) : existing}
                        </Badge>
                      ))}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <fieldset className="invite-box">
        <legend>{t('admin.grant')}</legend>
        <div className="form-grid">
          <Select
            label={t('admin.users')}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            options={rows.map((user) => ({
              value: user.id,
              label: user.email ?? user.name ?? user.id,
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
    </div>
  );
}

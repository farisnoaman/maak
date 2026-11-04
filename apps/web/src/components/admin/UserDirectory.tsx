import Link from 'next/link';
import { translate, type Locale, type TranslationKey } from '@maak/core';
import { Badge } from '@/components/ui/Feedback';

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

export const ROLE_LABEL: Record<string, TranslationKey> = {
  platform_admin: 'admin.role.platform_admin',
  platform_staff: 'admin.role.platform_staff',
  finance_officer: 'admin.role.finance_officer',
  geo_supervisor: 'admin.role.geo_supervisor',
};

/**
 * The directory: who has an account, whether it is verified, what it holds.
 *
 * This screen used to end in a form. Granting a role sat under the table as a fieldset of three inputs and two
 * buttons, so the page was two jobs in one column — you came to *read* 50 accounts and were handed a control
 * labelled "Revoke" on the way past, and the role summary you actually wanted ("who is a finance officer?") was
 * never computed at all because the table only listed people, never the roles.
 *
 * The list is now a list. Granting and revoking — the write, which is the dangerous half — is its own page
 * (`/admin/users/roles`), linked from the header and from every row, where it can show the ledger of who holds what
 * beside the control instead of below a scroll of 50 rows.
 */
export function UserDirectory({
  locale,
  users,
  truncated = false,
}: {
  readonly locale: Locale;
  readonly users: readonly AdminUserRow[];
  /** The read is capped; say so, because a silent cap reads as "this is everyone". */
  readonly truncated?: boolean;
}) {
  const t = (key: TranslationKey) => translate(locale, key);

  return (
    <section className="console-section">
      <div className="console-section__head">
        <h2>{t('admin.users')}</h2>
        <span className="console-section__meta">{users.length}</span>
      </div>
      <p className="form-hint">{truncated ? t('admin.usersCap') : t('admin.usersRecent')}</p>

      <div className="table-scroll" tabIndex={0}>
        <table className="data-table">
          <caption className="visually-hidden">{t('admin.users')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('admin.users')}</th>
              <th scope="col">{t('admin.verification')}</th>
              <th scope="col">{t('admin.roles')}</th>
              <th scope="col">
                <span className="visually-hidden">{t('admin.screenRoles')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <span className="form-hint">{t('admin.noUsers')}</span>
                </td>
              </tr>
            ) : null}
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <span>{user.name ?? t('admin.deletionUnnamed')}</span>
                  <span className="form-hint block" dir="ltr">
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
                    <span className="row-actions">
                      {user.roles.map((existing) => (
                        <Badge key={existing} tone="info">
                          {ROLE_LABEL[existing] ? t(ROLE_LABEL[existing]!) : existing}
                        </Badge>
                      ))}
                    </span>
                  )}
                </td>
                <td className="data-table__end">
                  <Link
                    className="ui-btn ui-btn--ghost ui-btn--sm"
                    href={`/${locale}/admin/users/roles?user=${encodeURIComponent(user.id)}`}
                  >
                    {t('admin.manageRoles')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

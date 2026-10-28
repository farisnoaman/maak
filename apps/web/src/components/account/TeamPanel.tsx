'use client';

import { useState } from 'react';
import {
  canInvite,
  canRemoveMember,
  errorKey,
  identityCommandSpec,
  translate,
  type Locale,
  type MemberRole,
  type TranslationKey,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { getApiClient } from '@/lib/api';

export interface TeamMember {
  readonly id: string;
  readonly userId: string | null;
  readonly role: MemberRole;
  readonly status: 'invited' | 'active' | 'suspended' | 'removed';
  readonly email: string | null;
  readonly phone: string | null;
}

type InvitableRole = 'manager' | 'accountant' | 'dispatcher';

const ROLE_LABEL: Record<MemberRole, TranslationKey> = {
  owner: 'org.role.owner',
  manager: 'org.role.manager',
  accountant: 'org.role.accountant',
  dispatcher: 'org.role.dispatcher',
};

/**
 * Membership management.
 *
 * The invite button's availability comes from `canInvite()` in `@maak/core` — the same function the
 * command mirrors in SQL — so a manager cannot even attempt to create an owner.
 */
export function TeamPanel({
  locale,
  orgId,
  orgName,
  actorRole,
  actorId,
  initialMembers,
  configured,
}: {
  readonly locale: Locale;
  readonly orgId: string;
  readonly orgName: string;
  readonly actorRole: MemberRole;
  readonly actorId: string | null;
  readonly initialMembers: readonly TeamMember[];
  readonly configured: boolean;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const invitable: InvitableRole[] = (
    ['manager', 'accountant', 'dispatcher'] as InvitableRole[]
  ).filter((candidate) => canInvite(actorRole, candidate));

  const [members, setMembers] = useState(initialMembers);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<InvitableRole>(invitable[0] ?? 'manager');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [transferTo, setTransferTo] = useState('');
  const [confirmTransfer, setConfirmTransfer] = useState(false);

  async function invite() {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    if (!email.trim() && !phone.trim()) {
      setError(t('errors.VALIDATION_FAILED'));
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);

    const result = await client.call(identityCommandSpec, {
      action: 'member.invite',
      orgId,
      role,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
    });

    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    const memberId = String(result.data.memberId ?? '');
    const token = typeof result.data.inviteToken === 'string' ? result.data.inviteToken : '';
    setMembers((current) => [
      ...current,
      {
        id: memberId,
        userId: null,
        role,
        status: 'invited',
        email: email.trim() || null,
        phone: phone.trim() || null,
      },
    ]);
    setEmail('');
    setPhone('');
    setMessage(t('org.inviteCreated'));

    // The raw token exists only in this response; the link is the only way to hand it over.
    if (memberId && token) {
      const origin = typeof window === 'undefined' ? '' : window.location.origin;
      const locale = window.location.pathname.split('/')[1] ?? 'ar';
      setInviteLink(`${origin}/${locale}/account/invitations?member=${memberId}&token=${token}`);
    }
  }

  async function remove(memberId: string) {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    setError(null);
    const result = await client.call(identityCommandSpec, {
      action: 'member.remove',
      memberId,
    });
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setMembers((current) =>
      current.map((member) =>
        member.id === memberId ? { ...member, status: 'removed' as const } : member,
      ),
    );
    setMessage(t('org.removed'));
  }

  async function transferOwnership() {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    if (!transferTo) return;
    setBusy(true);
    setError(null);
    const result = await client.call(identityCommandSpec, {
      action: 'organization.transferOwnership',
      orgId,
      memberId: transferTo,
    });
    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    const target = members.find((member) => member.id === transferTo);
    setMembers((current) =>
      current.map((member) => {
        if (member.id === transferTo) return { ...member, role: 'owner' as MemberRole };
        if (member.userId === actorId) return { ...member, role: 'manager' as MemberRole };
        return member;
      }),
    );
    setConfirmTransfer(false);
    setMessage(`${t('org.transferred')}${target?.email ? ` — ${target.email}` : ''}`);
  }

  async function leave() {
    const client = getApiClient();
    if (!client || !configured) {
      setError(t('verification.notConfigured'));
      return;
    }
    if (actorRole === 'owner') {
      setError(t('org.ownerMustTransfer'));
      return;
    }
    setBusy(true);
    const result = await client.call(identityCommandSpec, { action: 'member.leave', orgId });
    setBusy(false);
    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setMessage(t('org.left'));
  }

  const activeOthers = members.filter(
    (member) => member.status === 'active' && member.userId !== actorId,
  );

  return (
    <div className="card console-panel">
      <h2 style={{ fontSize: '1.05rem' }}>{t('org.members')}</h2>

      <table className="data-table">
        <caption className="visually-hidden">{t('org.members')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('org.inviteEmail')}</th>
            <th scope="col">{t('org.role')}</th>
            <th scope="col">{t('common.status')}</th>
            <th scope="col">
              <span className="visually-hidden">{t('org.remove')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.id}>
              <td dir="ltr">{member.email ?? member.phone ?? member.userId ?? '—'}</td>
              <td>
                {t(ROLE_LABEL[member.role])}
                {member.userId === actorId ? (
                  <span className="form-hint"> · {t('org.you')}</span>
                ) : null}
              </td>
              <td>
                {member.status === 'invited' ? (
                  <Badge tone="warning">{t('org.pending')}</Badge>
                ) : member.status === 'removed' ? (
                  <Badge tone="danger">{t('org.removed')}</Badge>
                ) : (
                  <Badge tone="success">{t('org.active')}</Badge>
                )}
              </td>
              <td>
                {member.status !== 'removed' &&
                canRemoveMember(actorRole, member.role, member.userId === actorId) ? (
                  <Button variant="ghost" size="sm" onClick={() => remove(member.id)}>
                    {t('org.remove')}
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {invitable.length > 0 ? (
        <fieldset className="invite-box">
          <legend>{t('org.invite')}</legend>
          <div className="form-grid">
            <Field
              label={t('org.inviteEmail')}
              type="email"
              dir="ltr"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Field
              label={t('org.invitePhone')}
              dir="ltr"
              inputMode="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              hint={t('common.optional')}
            />
            <Select
              label={t('org.role')}
              value={role}
              onChange={(event) => setRole(event.target.value as InvitableRole)}
              options={invitable.map((candidate) => ({
                value: candidate,
                label: t(ROLE_LABEL[candidate]),
              }))}
            />
          </div>
          <Button onClick={invite} loading={busy}>
            {t('org.inviteSend')}
          </Button>
        </fieldset>
      ) : (
        <p className="form-hint">{t('org.noTeam')}</p>
      )}

      {inviteLink ? (
        <div className="invite-box">
          <p style={{ fontWeight: 700 }}>{t('org.shareInvite')}</p>
          <p className="form-hint" dir="ltr" style={{ wordBreak: 'break-all' }}>
            {inviteLink}
          </p>
          <div className="form-actions">
            <Button
              variant="subtle"
              size="sm"
              onClick={async () => {
                await navigator.clipboard?.writeText(inviteLink);
                setMessage(t('org.copied'));
              }}
            >
              {t('org.copyLink')}
            </Button>
            <a
              className="ui-btn ui-btn--subtle ui-btn--sm"
              href={`https://wa.me/?text=${encodeURIComponent(
                t('org.inviteMessage', { org: orgName, link: inviteLink }),
              )}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              {t('org.shareWhatsapp')}
            </a>
          </div>
          <p className="form-hint">{t('org.inviteCreated')}</p>
        </div>
      ) : null}

      {actorRole === 'owner' && activeOthers.length > 0 ? (
        <fieldset className="invite-box">
          <legend>{t('org.transfer')}</legend>
          <div className="form-grid">
            <Select
              label={t('org.transferTo')}
              value={transferTo}
              onChange={(event) => {
                setTransferTo(event.target.value);
                setConfirmTransfer(false);
              }}
              options={[
                { value: '', label: '—' },
                ...activeOthers.map((member) => ({
                  value: member.id,
                  label: member.email ?? member.phone ?? member.id,
                })),
              ]}
            />
          </div>
          {confirmTransfer ? <p className="form-warning">{t('org.transferConfirm')}</p> : null}
          <div className="form-actions">
            <Button
              variant="danger"
              onClick={() => (confirmTransfer ? transferOwnership() : setConfirmTransfer(true))}
              disabled={!transferTo}
              loading={busy}
            >
              {t('org.transfer')}
            </Button>
          </div>
        </fieldset>
      ) : null}

      {actorRole !== 'owner' ? (
        <div className="form-actions">
          <Button variant="ghost" onClick={leave} loading={busy}>
            {t('org.leave')}
          </Button>
        </div>
      ) : null}

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

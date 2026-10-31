import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@maak/core';
import { loadAccountContext } from '@/lib/account';

/**
 * One door to "my console".
 *
 * The phone's tab bar has four destinations and one of them is the console — but a staff member and an
 * operator do not share one. Rather than make the tab bar guess (it is a client component: it knows the
 * path, not the role), this route asks the session and forwards:
 *
 *   platform staff  → /staff
 *   organization    → /operator
 *   passenger only  → /account
 *
 * A redirect is the honest answer here: it is one hop, it works without JavaScript, and it keeps a staff
 * member out of an operator console that would answer FORBIDDEN.
 */
export default async function ConsoleEntryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const loaded = await loadAccountContext();
  if (loaded.configured && !loaded.user) {
    redirect(`/${locale}/auth/sign-in?next=/${locale}/console`);
  }

  if (loaded.roles.includes('platform_staff') || loaded.roles.includes('platform_admin')) {
    redirect(`/${locale}/staff`);
  }

  const hasOrganization = loaded.organizations.some(
    (organization) => organization.status === 'active',
  );
  redirect(`/${locale}/${hasOrganization ? 'operator' : 'account'}`);
}

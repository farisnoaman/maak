import { notFound, redirect } from 'next/navigation';
import { isLocale, type Locale } from '@maak/core';
import { isSupabaseConfigured } from '@/lib/supabase/config';
import { getSession } from '@/lib/supabase/server';
import { SignUpForm } from '@/components/auth/SignUpForm';
import { AuthAside } from '@/components/auth/AuthAside';
import { StorageAccessPrompt } from '@/components/auth/StorageAccessPrompt';
import { SiteHeader } from '@/components/SiteHeader';

/**
 * Registration.
 *
 * The sign-in page has always carried a *Create account* line under the form. It pointed back at the sign-in page —
 * the door opened onto itself, so a new passenger had no way to become one. There is no second database rule to
 * invent here: `app.handle_new_user` already writes the profile row from the sign-up metadata, so this is a form,
 * one endpoint, and the words around them.
 */
export default async function SignUpPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string; sent?: string; error?: string }>;
}) {
  const { locale: raw } = await params;
  const { next, sent, error } = await searchParams;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

  // Somebody who is already signed in does not need a registration form.
  const session = await getSession();
  if (session.configured && session.user) redirect(`/${locale}/account`);

  const safeNext = next && /^\/[a-z]{2}(\/|$)/.test(next) ? next : undefined;

  return (
    <>
      <SiteHeader locale={locale} pathname="/auth/sign-up" />
      <main id="main" className="shell auth-page">
        <StorageAccessPrompt locale={locale} />
        <div className="auth-cols">
          <SignUpForm
            locale={locale}
            configured={isSupabaseConfigured()}
            next={safeNext}
            sent={sent === '1'}
            error={error}
          />
          <AuthAside locale={locale} title="auth.asideSignUp" />
        </div>
      </main>
    </>
  );
}

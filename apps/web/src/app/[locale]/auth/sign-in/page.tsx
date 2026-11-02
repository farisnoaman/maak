import { notFound } from 'next/navigation';
import { isLocale, type Locale } from '@maak/core';
import { isSupabaseConfigured } from '@/lib/supabase/config';
import { SignInForm, type SignInTab } from '@/components/auth/SignInForm';
import { AuthAside } from '@/components/auth/AuthAside';
import { StorageAccessPrompt } from '@/components/auth/StorageAccessPrompt';
import { SiteHeader } from '@/components/SiteHeader';

export default async function SignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    next?: string;
    tab?: string;
    step?: string;
    phone?: string;
    error?: string;
  }>;
}) {
  const { locale: raw } = await params;
  const { next, tab, step, phone, error } = await searchParams;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;

  // Only allow same-origin, locale-prefixed redirects: an open redirect is a phishing primitive.
  const safeNext = next && /^\/[a-z]{2}(\/|$)/.test(next) ? next : undefined;
  const safePhone = step === 'code' && phone ? phone : undefined;
  const activeTab: SignInTab = safePhone || tab === 'phone' ? 'phone' : 'email';

  return (
    <>
      <SiteHeader locale={locale} pathname="/auth/sign-in" />
      <main id="main" className="shell auth-page">
        <StorageAccessPrompt locale={locale} />
        <div className="auth-cols">
          <SignInForm
            locale={locale}
            configured={isSupabaseConfigured()}
            next={safeNext}
            tab={activeTab}
            phone={safePhone}
            error={error}
          />
          <AuthAside locale={locale} title="auth.asideSignIn" />
        </div>
      </main>
    </>
  );
}

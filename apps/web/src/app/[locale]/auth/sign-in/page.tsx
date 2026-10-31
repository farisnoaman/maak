import { notFound } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { isSupabaseConfigured } from '@/lib/supabase/config';
import { SignInForm, type SignInTab } from '@/components/auth/SignInForm';

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
  const t = (key: TranslationKey) => translate(locale, key);

  // Only allow same-origin, locale-prefixed redirects: an open redirect is a phishing primitive.
  const safeNext = next && /^\/[a-z]{2}(\/|$)/.test(next) ? next : undefined;
  const safePhone = step === 'code' && phone ? phone : undefined;
  const activeTab: SignInTab = safePhone || tab === 'phone' ? 'phone' : 'email';

  return (
    <main id="main" className="auth-shell">
      <div className="shell">
        <SignInForm
          locale={locale}
          configured={isSupabaseConfigured()}
          next={safeNext}
          tab={activeTab}
          phone={safePhone}
          error={error}
        />
        <p className="auth-foot">
          <span>{t('auth.noAccount')}</span>
          <a href={`/${locale}/auth/sign-in`}>{t('auth.createAccount')}</a>
        </p>
      </div>
    </main>
  );
}

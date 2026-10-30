import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { translate, isLocale, type Locale, type TranslationKey } from '@maak/core';
import { SiteHeader } from '@/components/SiteHeader';
import { FareCalculator } from '@/components/FareCalculator';

export const metadata: Metadata = {
  alternates: {
    languages: { ar: '/ar', en: '/en' },
  },
};

const CONSOLES: { key: TranslationKey; phase: string; note: TranslationKey }[] = [
  { key: 'console.public', phase: '4', note: 'home.verified' },
  { key: 'console.operator', phase: '3', note: 'home.verified' },
  { key: 'console.staff', phase: '7', note: 'home.verified' },
  { key: 'console.admin', phase: '10', note: 'home.verified' },
  { key: 'console.finance', phase: '10', note: 'home.verified' },
  { key: 'console.driver', phase: '6', note: 'home.verified' },
  { key: 'console.passenger', phase: '5', note: 'home.verified' },
];

const FOUNDATIONS: { icon: string; title: TranslationKey; body: TranslationKey }[] = [
  { icon: '🔒', title: 'home.foundationSecurity', body: 'home.foundationSecurityDesc' },
  { icon: '🧠', title: 'home.foundationLogic', body: 'home.foundationLogicDesc' },
  { icon: '🌍', title: 'home.foundationI18n', body: 'home.foundationI18nDesc' },
];

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  return (
    <>
      <SiteHeader locale={locale} />

      <main id="main">
        <section className="hero">
          <div className="shell hero__grid">
            <div>
              <span className="eyebrow">
                <span aria-hidden="true">◆</span>
                {t('home.eyebrow')}
              </span>
              <h1>{t('home.heroTitle')}</h1>
              <p className="lead">{t('home.heroSubtitle')}</p>
              <div className="hero__actions">
                <a className="btn btn--primary" href="#consoles">
                  {t('home.ctaExplore')}
                </a>
                <a className="btn btn--ghost" href="#foundations">
                  {t('home.ctaOperator')}
                </a>
              </div>
              <div className="hero__stats">
                <div>
                  <div className="stat__value num">268</div>
                  <div className="stat__label">{t('home.statTests')}</div>
                </div>
                <div>
                  <div className="stat__value num">2</div>
                  <div className="stat__label">{t('home.statLocales')}</div>
                </div>
                <div>
                  <div className="stat__value num">22</div>
                  <div className="stat__label">{t('home.statGovernorates')}</div>
                </div>
              </div>
            </div>
            <FareCalculator locale={locale} />
          </div>
        </section>

        <section className="section section--muted" id="foundations">
          <div className="shell">
            <div className="section__head">
              <h2>{t('home.sectionFoundations')}</h2>
            </div>
            <div className="grid-3">
              {FOUNDATIONS.map((item) => (
                <article className="feature" key={item.title}>
                  <div className="feature__icon" aria-hidden="true">
                    {item.icon}
                  </div>
                  <h3>{t(item.title)}</h3>
                  <p>{t(item.body)}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="consoles">
          <div className="shell">
            <div className="section__head">
              <h2>{t('home.sectionConsoles')}</h2>
            </div>
            <div className="consoles">
              {CONSOLES.map((consoleItem) => (
                <article className="console-card" key={consoleItem.key}>
                  <div className="console-card__top">
                    <h3>{t(consoleItem.key)}</h3>
                    <span className="pill pill--planned">
                      {t('common.phase')} {consoleItem.phase}
                    </span>
                  </div>
                  <p>{t('common.comingSoon')}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="shell site-footer__inner">
          <span>
            {t('common.appName')} · {t('common.tagline')}
          </span>
          <span className="num">{t('common.footerStack')}</span>
        </div>
      </footer>
    </>
  );
}

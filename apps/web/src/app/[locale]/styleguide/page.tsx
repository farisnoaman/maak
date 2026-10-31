import { notFound } from 'next/navigation';
import { isLocale, translate, type Locale, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Badge, EmptyState, Skeleton } from '@/components/ui/Feedback';
import { DirectionalIcon } from '@/components/ui/DirectionalIcon';
import { StyleguideInteractive } from '@/components/ui/StyleguideInteractive';
import { SiteHeader } from '@/components/SiteHeader';

/**
 * A living checklist for the primitives. Open it in Arabic and in English: if something looks
 * wrong in one direction, it is wrong here first — before it spreads into feature screens.
 */
export default async function StyleguidePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: raw } = await params;
  const query = new URLSearchParams(
    Object.entries(await searchParams).flatMap(([key, value]) =>
      value === undefined
        ? []
        : [[key, Array.isArray(value) ? (value[0] ?? '') : value] as [string, string]],
    ),
  ).toString();
  if (!isLocale(raw)) notFound();
  const locale: Locale = raw;
  const t = (key: TranslationKey) => translate(locale, key);

  return (
    <>
      <SiteHeader locale={locale} pathname="/styleguide" search={query} />
      <main id="main" className="shell section">
        <header className="section__head">
          <h1>{t('styleguide.title')}</h1>
          <p>{t('styleguide.subtitle')}</p>
        </header>

        <section aria-labelledby="sg-buttons" className="section">
          <h2 id="sg-buttons">{t('styleguide.buttons')}</h2>
          <div className="sg-row">
            <Button>{t('common.continue')}</Button>
            <Button variant="ghost">{t('common.cancel')}</Button>
            <Button variant="subtle" size="sm">
              {t('common.save')}
            </Button>
            <Button variant="danger" size="lg">
              {t('common.cancel')}
            </Button>
            <Button loading>{t('common.loading')}</Button>
            <Button disabled>{t('common.comingSoon')}</Button>
          </div>
          <div className="sg-row">
            <Button iconEnd={<DirectionalIcon direction="forward" />}>
              {t('common.continue')}
            </Button>
            <Button variant="ghost" iconStart={<DirectionalIcon direction="back" />}>
              {t('common.retry')}
            </Button>
            <span className="sg-label">{t('styleguide.direction')}</span>
          </div>
        </section>

        <section aria-labelledby="sg-inputs" className="section">
          <h2 id="sg-inputs">{t('styleguide.inputs')}</h2>
          <div className="sg-grid">
            <Field label={t('styleguide.email')} hint={t('styleguide.emailHint')} type="email" />
            <Field
              label={t('styleguide.email')}
              error={t('styleguide.emailError')}
              defaultValue={locale === 'ar' ? 'maak' : 'maak'}
            />
            <Select
              label={t('styleguide.city')}
              defaultValue="aden"
              options={[
                { value: 'aden', label: locale === 'ar' ? 'عدن' : 'Aden' },
                { value: 'sanaa', label: locale === 'ar' ? 'صنعاء' : "Sana'a" },
                { value: 'taiz', label: locale === 'ar' ? 'تعز' : 'Taiz' },
              ]}
            />
          </div>
        </section>

        <section aria-labelledby="sg-feedback" className="section">
          <h2 id="sg-feedback">{t('styleguide.feedback')}</h2>
          <div className="sg-row">
            <Badge tone="success">{t('home.verified')}</Badge>
            <Badge tone="warning">{t('common.phase')} 1</Badge>
            <Badge tone="danger">{t('common.cancel')}</Badge>
            <Badge>{t('common.comingSoon')}</Badge>
          </div>
          <div className="sg-grid">
            <div>
              <Skeleton height={18} width="70%" label={t('styleguide.loading')} />
              <div style={{ blockSize: 'var(--space-3)' }} />
              <Skeleton height={14} width="45%" />
            </div>
            <EmptyState
              title={t('styleguide.emptyTitle')}
              description={t('styleguide.emptyDesc')}
              action={<Button size="sm">{t('styleguide.emptyAction')}</Button>}
            />
          </div>
        </section>

        <StyleguideInteractive
          dialogTitle={t('styleguide.dialog')}
          dialogBody={t('styleguide.dialogBody')}
          openLabel={t('styleguide.openDialog')}
          closeLabel={t('styleguide.close')}
          toastLabel={t('styleguide.showToast')}
          toastTitle={t('styleguide.toastTitle')}
          toastDescription={t('styleguide.toastDesc')}
        />
      </main>
    </>
  );
}

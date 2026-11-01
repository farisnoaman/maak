import Link from 'next/link';
import type { Locale } from '@maak/core';
import { legalDocument, type LegalDocumentId } from '@/lib/legal';

/**
 * One document, rendered from data.
 *
 * Deliberately boring: a heading, the date it changed, sections with paragraphs, and a way back. A legal page
 * that needs a designer before it can ship is a legal page that ships late, and the two things that actually
 * matter here — both languages present, and a date a reader can check — are enforced by the data and its test,
 * not by the layout.
 */
export function LegalPage({
  locale,
  id,
}: {
  readonly locale: Locale;
  readonly id: LegalDocumentId;
}) {
  const doc = legalDocument(id, locale);
  const other: Locale = locale === 'ar' ? 'en' : 'ar';

  return (
    <main id="main" className="shell section legal">
      <p className="form-hint">
        <Link href={`/${other}/${id}`} hrefLang={other} lang={other}>
          {other === 'ar' ? 'العربية' : 'English'}
        </Link>
      </p>
      <h1>{doc.title}</h1>
      <p className="form-hint">
        {locale === 'ar' ? 'آخر تحديث' : 'Last updated'}:{' '}
        <time dateTime={doc.updated} dir="ltr">
          {doc.updated}
        </time>
      </p>
      <p className="legal__intro">{doc.intro}</p>
      {doc.sections.map((section) => (
        <section key={section.heading}>
          <h2>{section.heading}</h2>
          {section.body.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </section>
      ))}
      <p className="form-hint">
        <Link href={`/${locale}`}>{locale === 'ar' ? 'العودة إلى الرئيسية' : 'Back to home'}</Link>
      </p>
    </main>
  );
}

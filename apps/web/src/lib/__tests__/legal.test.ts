import { describe, expect, it } from 'vitest';
import { LEGAL_DOCUMENTS, LEGAL_UPDATED, legalDocument, type LegalDocumentId } from '../legal';

const ids: LegalDocumentId[] = ['privacy', 'terms'];

/**
 * The failure mode of a legal page is silence: one language missing a clause, or a date that stops moving. Both
 * are cheap to assert and impossible to see by reading one language.
 */
describe('legal documents', () => {
  it.each(ids)('%s has the same sections in Arabic and English', (id) => {
    const ar = legalDocument(id, 'ar');
    const en = legalDocument(id, 'en');
    expect(ar.sections).toHaveLength(en.sections.length);
    expect(ar.sections.map((section) => section.body.length)).toEqual(
      en.sections.map((section) => section.body.length),
    );
  });

  it.each(ids)('%s has no empty heading or body in either language', (id) => {
    for (const locale of ['ar', 'en'] as const) {
      const doc = legalDocument(id, locale);
      expect(doc.title.trim().length).toBeGreaterThan(0);
      expect(doc.intro.trim().length).toBeGreaterThan(0);
      expect(doc.updated).toBe(LEGAL_UPDATED);
      for (const section of doc.sections) {
        expect(section.heading.trim().length).toBeGreaterThan(0);
        expect(section.body.length).toBeGreaterThan(0);
        for (const paragraph of section.body) expect(paragraph.trim().length).toBeGreaterThan(20);
      }
    }
  });

  it.each(ids)('%s is written in the right script for each locale', (id) => {
    // A copy-paste that leaves English text in the Arabic document is invisible to a reviewer skimming a diff
    // and obvious to a reader — so it is a test.
    const arabic = /[\u0600-\u06FF]/;
    const ar = legalDocument(id, 'ar');
    const en = legalDocument(id, 'en');
    expect(arabic.test(ar.title)).toBe(true);
    expect(arabic.test(ar.sections.map((s) => s.body.join(' ')).join(' '))).toBe(true);
    expect(arabic.test(en.title)).toBe(false);
    expect(arabic.test(en.sections.map((s) => s.body.join(' ')).join(' '))).toBe(false);
  });

  it('gives each document a distinct title', () => {
    expect(LEGAL_DOCUMENTS.privacy.ar.title).not.toBe(LEGAL_DOCUMENTS.terms.ar.title);
    expect(LEGAL_DOCUMENTS.privacy.en.title).not.toBe(LEGAL_DOCUMENTS.terms.en.title);
  });
});

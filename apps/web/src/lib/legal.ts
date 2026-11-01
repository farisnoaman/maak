/**
 * The two documents a marketplace cannot launch without, in both languages.
 *
 * They are plain data rather than a page of JSX so that the parity that matters is checkable: the Arabic and
 * English versions must have the same sections in the same order, none empty, and the same "last updated" date.
 * `apps/web/src/lib/__tests__/legal.test.ts` asserts exactly that, because the failure mode of a legal page is
 * not a crash — it is one language quietly missing a clause for a year.
 *
 * Written for the product as it is: no card processor (a receipt and a human), no location tracking beyond the
 * driver's 10-minute pings, identity documents purged 90 days after a booking closes. When any of those change,
 * this file is what changes — which is why it is not a copy deck kept in somebody's drive.
 */

import type { Locale } from '@maak/core';

export interface LegalSection {
  readonly heading: string;
  readonly body: readonly string[];
}

export interface LegalDocument {
  readonly title: string;
  readonly updated: string;
  readonly intro: string;
  readonly sections: readonly LegalSection[];
}

export type LegalDocumentId = 'privacy' | 'terms';

export const LEGAL_UPDATED = '2026-11-01';

const privacy: Record<Locale, LegalDocument> = {
  ar: {
    title: 'سياسة الخصوصية',
    updated: LEGAL_UPDATED,
    intro:
      'توضّح هذه السياسة ما تجمعه منصة «معك» عنك، ولماذا، وكم تحتفظ به، وما يمكنك طلبه في أي وقت. منصة معك وسيط بين المسافرين ومشغّلي النقل في اليمن؛ ولا نبيع بياناتك.',
    sections: [
      {
        heading: 'ما نجمعه',
        body: [
          'بيانات الحساب: الاسم، رقم الجوال، البريد الإلكتروني، اللغة المفضلة.',
          'بيانات التحقق: نوع ورقم الوثيقة الوطنية أو جواز السفر، وصورة الوثيقة عند رفعها للتحقق. تصل إليها لجنة التحقق فقط.',
          'بيانات الحجوزات: الرحلة، المقاعد، مبلغ الدفع، واسم جهة الاتصال ورقمها لكل حجز.',
          'إثباتات الدفع: صورة الإيصال التي ترفعها، وبصمة الملف (بصمة تشفيرية) لمنع استخدام الإيصال نفسه مرتين. تُحذف الصور بعد 180 يومًا من تسوية الدفع.',
          'بيانات الموقع: موقع السائق فقط، كل عشر دقائق أثناء الرحلة، لحساب التقدم والوصول. لا نتتبّع موقع المسافر.',
          'سجلات الاستخدام: سجل تدقيق للأحداث المالية والإدارية، محفوظ لأغراض المراجعة والامتثال.',
        ],
      },
      {
        heading: 'كم نحتفظ بالبيانات',
        body: [
          'وثائق الهوية تُحذف بعد 90 يومًا من إغلاق الحجز المرتبط بها.',
          'صور إثباتات الدفع تُحذف بعد 180 يومًا.',
          'سجل التدقيق والقيود المالية تبقى مدة أطول لأنها السجل المحاسبي، وليس فيها ما يعرّف بشخصك بعد حذف الحساب.',
        ],
      },
      {
        heading: 'من يرى بياناتك',
        body: [
          'مشغّل الرحلة يرى اسمك ورقم جهة الاتصال للحجز فقط، لا وثائقك.',
          'لجنة التحقق ترى وثيقة الهوية لاتخاذ قرار التوثيق.',
          'فريق الدعم المالي يرى إثبات الدفع ومبلغه لتأكيده.',
          'لا نشارك بياناتك مع أي طرف ثالث لأغراض تسويقية، ولا نبيعها.',
        ],
      },
      {
        heading: 'حقوقك',
        body: [
          'يمكنك تعديل بيانات حسابك من صفحة الحساب.',
          'يمكنك طلب حذف حسابك من صفحة الحساب؛ يُنفَّذ الحذف بواسطة مدير المنصة، ويُخفي هويتك من السجلات ويحتفظ بالقيود المالية وحدها.',
          'يمكنك ضبط قنوات التنبيه لكل حدث، وساعات الهدوء، من صفحة تفضيلات التنبيهات.',
        ],
      },
      {
        heading: 'التواصل',
        body: ['لأي سؤال عن الخصوصية أو لطلب نسخة من بياناتك، راسلنا على privacy@maak.test.'],
      },
    ],
  },
  en: {
    title: 'Privacy policy',
    updated: LEGAL_UPDATED,
    intro:
      'This policy explains what Maak collects about you, why, how long it is kept, and what you can ask for at any time. Maak is a marketplace that connects passengers with transport operators in Yemen. We do not sell your data.',
    sections: [
      {
        heading: 'What we collect',
        body: [
          'Account data: name, phone number, email address, preferred language.',
          'Verification data: the type and number of your national ID or passport, and a photograph of the document when you upload one. Only the verification team can read it.',
          'Booking data: the trip, the seats, the amount paid, and a contact name and phone for each booking.',
          'Payment proofs: the receipt image you upload, and a cryptographic hash of the file so the same receipt cannot pay twice. Images are deleted 180 days after the payment is settled.',
          'Location data: the driver’s position only, every ten minutes while a trip is running, to compute progress and arrival. Passengers are never tracked.',
          'Usage logs: an audit trail of financial and administrative events, kept for review and compliance.',
        ],
      },
      {
        heading: 'How long we keep it',
        body: [
          'Identity documents are purged 90 days after the booking they belong to closes.',
          'Payment proof images are deleted after 180 days.',
          'The audit trail and financial ledger are kept longer because they are the accounting record, and they contain nothing that identifies you once an account is deleted.',
        ],
      },
      {
        heading: 'Who can see it',
        body: [
          'The operator of a trip sees your name and booking contact only — never your documents.',
          'The verification review team sees your identity document to decide verification.',
          'The finance desk sees a payment proof and its amount to confirm it.',
          'We share nothing with third parties for marketing, and we never sell it.',
        ],
      },
      {
        heading: 'Your rights',
        body: [
          'You can change your account details from your account page.',
          'You can request deletion of your account from your account page. A platform administrator executes it; it removes your identifying data from the records and keeps only the financial ledger.',
          'You can choose a channel for every notification event, and set quiet hours, from your notification preferences.',
        ],
      },
      {
        heading: 'Contact',
        body: [
          'For any privacy question, or to ask for a copy of your data, write to privacy@maak.test.',
        ],
      },
    ],
  },
};

const terms: Record<Locale, LegalDocument> = {
  ar: {
    title: 'شروط الاستخدام',
    updated: LEGAL_UPDATED,
    intro:
      'باستخدامك منصة «معك» فإنك توافق على هذه الشروط. معك تربط المسافرين بمشغّلي النقل، وتكون طرفًا في تنظيم الحجز والدفع، لا في تشغيل المركبة.',
    sections: [
      {
        heading: 'الحساب',
        body: [
          'يجب أن تكون البيانات التي تسجّلها صحيحة، وأن يكون عمرك 18 عامًا أو أكثر.',
          'المشغّل يحتاج توثيقًا قبل نشر أي رحلة، والسائق قبل تعيينه، وفق اشتراطات النقل في اليمن.',
          'أنت مسؤول عن حماية بيانات دخولك وعن كل نشاط يجري من حسابك.',
        ],
      },
      {
        heading: 'الحجز والدفع',
        body: [
          'الحجز يصبح مؤكدًا بعد قبول المشغّل، وبعد سداد الدفعة المطلوبة في الرحلات التي تشترط الدفع المسبق.',
          'الدفع يتم بتحويل إلى حساب المشغّل المعلن، ويرفع المسافر صورة الإيصال، ويؤكده فريق مالي بشري. لا نتقاضى من بطاقات.',
          'المبالغ بالريال اليمني كما تظهر في صفحة الرحلة قبل التأكيد.',
          'الإلغاء والاسترداد يتبعان سياسة الرحلة المعلنة: 100% أو 75% أو 50% من المبلغ حسب الوقت المتبقي للإقلاع. إذا ألغى المشغّل الرحلة يُرد المبلغ كاملًا.',
        ],
      },
      {
        heading: 'سلوك المستخدم',
        body: [
          'يُمنع استخدام المنصة في أي غرض غير قانوني أو لانتحال شخصية غيرك أو لإعادة بيع الحجوزات دون إذن.',
          'للمشغّل أن يرفض حجزًا أو يلغي رحلة وفق سياسته المعلنة، ويُبلَّغ المسافر بذلك.',
        ],
      },
      {
        heading: 'حدود المسؤولية',
        body: [
          'معك ليست الناقل؛ المسؤولية عن الرحلة والمركبة والسائق تقع على المشغّل المرخّص.',
          'نبذل جهدًا معقولًا لإبقاء المنصة متاحة ودقيقة، ولا نضمن عدم انقطاعها.',
        ],
      },
      {
        heading: 'التغييرات والقانون الواجب',
        body: [
          'قد نحدّث هذه الشروط، وسننشر تاريخ التحديث في أعلى الصفحة، ونبلغ المستخدمين المسجّلين بالتغييرات الجوهرية.',
          'تخضع هذه الشروط لأحكام القانون اليمني.',
        ],
      },
    ],
  },
  en: {
    title: 'Terms of use',
    updated: LEGAL_UPDATED,
    intro:
      'By using Maak you agree to these terms. Maak connects passengers with transport operators and is a party to arranging the booking and the payment — not to operating the vehicle.',
    sections: [
      {
        heading: 'Your account',
        body: [
          'The details you register must be accurate, and you must be 18 or older.',
          'An operator must be verified before publishing a trip, and a driver before being assigned one, in line with Yemeni transport rules.',
          'You are responsible for keeping your sign-in details safe and for everything done from your account.',
        ],
      },
      {
        heading: 'Bookings and payment',
        body: [
          'A booking is confirmed once the operator accepts it, and once the required deposit is paid on trips that require prepayment.',
          'Payment is a transfer to the operator’s published account: the passenger uploads a receipt image and a human on the finance desk confirms it. We do not charge cards.',
          'Amounts are in Yemeni riyals, exactly as shown on the trip page before you confirm.',
          'Cancellation and refunds follow the trip’s published policy: 100%, 75% or 50% by time remaining before departure. If the operator cancels the trip, the full amount is refunded.',
        ],
      },
      {
        heading: 'Acceptable use',
        body: [
          'You may not use the platform for anything unlawful, to impersonate anyone, or to resell bookings without permission.',
          'An operator may decline a booking or cancel a trip under its published policy, and the passenger is told either way.',
        ],
      },
      {
        heading: 'Limits of responsibility',
        body: [
          'Maak is not the carrier; responsibility for the trip, the vehicle and the driver rests with the licensed operator.',
          'We make a reasonable effort to keep the platform available and accurate, and we do not promise it will never be interrupted.',
        ],
      },
      {
        heading: 'Changes and governing law',
        body: [
          'We may update these terms; the date at the top of the page changes when we do, and registered users are told about material changes.',
          'These terms are governed by the laws of Yemen.',
        ],
      },
    ],
  },
};

export const LEGAL_DOCUMENTS: Record<LegalDocumentId, Record<Locale, LegalDocument>> = {
  privacy,
  terms,
};

export function legalDocument(id: LegalDocumentId, locale: Locale): LegalDocument {
  return LEGAL_DOCUMENTS[id][locale];
}

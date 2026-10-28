import type { Locale } from './locale';

/**
 * Flat dictionaries. Keep keys grouped by feature: `errors.*`, `common.*`, `trip.*`, `finance.*`.
 * Every key here must exist in both files — `tests/i18n.test.ts` fails the build otherwise.
 */
export const ar = {
  'common.appName': 'معك',
  'common.tagline': 'منصة إدارة الرحلات في اليمن',
  'common.language': 'اللغة',
  'common.arabic': 'العربية',
  'common.english': 'English',
  'common.currency': 'ر.ي',
  'common.continue': 'متابعة',
  'common.cancel': 'إلغاء',
  'common.save': 'حفظ',
  'common.loading': 'جارٍ التحميل…',
  'common.retry': 'إعادة المحاولة',
  'common.comingSoon': 'قريبًا',
  'common.phase': 'المرحلة',

  'home.heroTitle': 'سافر بثقة، وأدر رحلاتك من مكان واحد',
  'home.heroSubtitle':
    'حسابات أفراد وشركات، مركبات وسائقون موثّقون، رحلات عامة بفلاتر ذكية، حجز آمن، تتبّع مباشر، ودفع ومحاسبة شفافة.',
  'home.ctaExplore': 'استكشف الرحلات',
  'home.ctaOperator': 'ابدأ كمنظّم',
  'home.verified': 'موثّق',
  'home.sectionConsoles': 'المنصات',
  'home.sectionFoundations': 'الأساس التقني',
  'home.foundationSecurity': 'بوابة كتابة واحدة',
  'home.foundationSecurityDesc':
    'كل تعديل يمرّ عبر Edge Function تتحقق من الصلاحيات، ثم عملية SQL واحدة ذرّية. لا يوجد مسار كتابة آخر.',
  'home.foundationLogic': 'منطق واحد لكل الجهات',
  'home.foundationLogicDesc':
    'التسعير والدفتر المالي والسياسات مكتوبة مرة واحدة في TypeScript، ومختبرة بـ Vitest بدون قاعدة بيانات.',
  'home.foundationI18n': 'عربي وإنجليزي بجدارة',
  'home.foundationI18nDesc':
    'تخطيط RTL/LTR كامل، وكل نص موجود في اللغتين، والبناء يفشل إذا نقص أي مفتاح.',

  'calc.title': 'جرّب حساب السعر',
  'calc.subtitle': 'نفس الدالة التي تعمل على الخادم، تعمل الآن في متصفحك.',
  'calc.pricePerSeat': 'سعر المقعد',
  'calc.seats': 'عدد المقاعد',
  'calc.discount': 'الخصم ٪',
  'calc.subtotal': 'المجموع',
  'calc.discountAmount': 'الخصم',
  'calc.total': 'الإجمالي',
  'calc.note': 'هذه معاينة فقط؛ السعر النهائي يُحتسب ويُتحقق منه على الخادم.',

  'console.public': 'الرحلات العامة',
  'console.operator': 'لوحة المنظّم',
  'console.staff': 'لوحة الموظفين',
  'console.admin': 'الإدارة',
  'console.finance': 'المالية',
  'console.driver': 'تطبيق السائق',
  'console.passenger': 'تطبيق المسافر',

  'errors.NOT_VERIFIED': 'حسابك غير موثّق. أكمل التوثيق للمتابعة.',
  'errors.FORBIDDEN': 'لا تملك صلاحية تنفيذ هذا الإجراء.',
  'errors.UNAUTHENTICATED': 'يجب تسجيل الدخول أولًا.',
  'errors.VALIDATION_FAILED': 'تحقّق من الحقول المطلوبة.',
  'errors.NOT_FOUND': 'لم يتم العثور على العنصر.',
  'errors.QUOTA_EXCEEDED': 'تجاوزت حد خطتك. قم بالترقية للمتابعة.',
  'errors.EDIT_WINDOW_CLOSED': 'لا يمكن التعديل قبل أقل من ساعتين من موعد الانطلاق.',
  'errors.CANCEL_WINDOW_CLOSED': 'لا يمكن الإلغاء قبل أقل من ساعتين من موعد الانطلاق.',
  'errors.NO_SEATS_LEFT': 'لم تعد هناك مقاعد متاحة.',
  'errors.PRICE_CHANGED': 'تغيّر السعر. راجع التفاصيل قبل المتابعة.',
  'errors.TRIP_NOT_VERIFIED': 'لا يمكن بدء رحلة غير موثّقة.',
  'errors.RATE_LIMITED': 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.',
  'errors.CONFLICT': 'تغيّرت البيانات منذ آخر تحديث. أعد المحاولة.',
  'errors.INTERNAL': 'حدث خطأ غير متوقع. حاول مرة أخرى.',
  'errors.NETWORK': 'تعذّر الاتصال بالخادم. تحقّق من الشبكة.',
} as const;

export type TranslationKey = keyof typeof ar;

export const en: Record<TranslationKey, string> = {
  'common.appName': 'Maak',
  'common.tagline': 'Trip management for Yemen',
  'common.language': 'Language',
  'common.arabic': 'العربية',
  'common.english': 'English',
  'common.currency': 'YER',
  'common.continue': 'Continue',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.loading': 'Loading…',
  'common.retry': 'Try again',
  'common.comingSoon': 'Coming soon',
  'common.phase': 'Phase',

  'home.heroTitle': 'Travel with confidence. Run everything from one place.',
  'home.heroSubtitle':
    'Verified individuals and companies, vehicles and drivers, a public trip marketplace with smart filters, safe bookings, live tracking, and transparent payments and accounting.',
  'home.ctaExplore': 'Explore trips',
  'home.ctaOperator': 'Start operating',
  'home.verified': 'Verified',
  'home.sectionConsoles': 'Surfaces',
  'home.sectionFoundations': 'Technical foundations',
  'home.foundationSecurity': 'One write path',
  'home.foundationSecurityDesc':
    'Every change goes through an Edge Function that checks permissions, then a single atomic SQL command. There is no other way to write.',
  'home.foundationLogic': 'One brain, every client',
  'home.foundationLogicDesc':
    'Pricing, the ledger and policies are written once in TypeScript and tested with Vitest — no database required.',
  'home.foundationI18n': 'Arabic and English, properly',
  'home.foundationI18nDesc':
    'Full RTL and LTR layouts, every string in both languages, and the build fails when a key is missing.',

  'calc.title': 'Try the fare calculation',
  'calc.subtitle': 'The same function that runs on the server is running in your browser right now.',
  'calc.pricePerSeat': 'Price per seat',
  'calc.seats': 'Seats',
  'calc.discount': 'Discount %',
  'calc.subtotal': 'Subtotal',
  'calc.discountAmount': 'Discount',
  'calc.total': 'Total',
  'calc.note': 'Preview only — the final price is recomputed and verified on the server.',

  'console.public': 'Public trips',
  'console.operator': 'Operator console',
  'console.staff': 'Staff console',
  'console.admin': 'Admin',
  'console.finance': 'Finance',
  'console.driver': 'Driver app',
  'console.passenger': 'Passenger app',

  'errors.NOT_VERIFIED': 'Your account is not verified. Complete verification to continue.',
  'errors.FORBIDDEN': 'You do not have permission to do this.',
  'errors.UNAUTHENTICATED': 'Please sign in first.',
  'errors.VALIDATION_FAILED': 'Please check the required fields.',
  'errors.NOT_FOUND': 'That item could not be found.',
  'errors.QUOTA_EXCEEDED': 'You have reached your plan limit. Upgrade to continue.',
  'errors.EDIT_WINDOW_CLOSED': 'Trips cannot be edited within two hours of departure.',
  'errors.CANCEL_WINDOW_CLOSED': 'Bookings cannot be cancelled within two hours of departure.',
  'errors.NO_SEATS_LEFT': 'No seats are left on this trip.',
  'errors.PRICE_CHANGED': 'The price changed. Please review before continuing.',
  'errors.TRIP_NOT_VERIFIED': 'This trip cannot start until it is verified.',
  'errors.RATE_LIMITED': 'Too many attempts. Please wait and try again.',
  'errors.CONFLICT': 'This item changed since you loaded it. Please retry.',
  'errors.INTERNAL': 'Something went wrong. Please try again.',
  'errors.NETWORK': 'Could not reach the server. Check your connection.',
};

export const dictionaries: Record<Locale, Record<TranslationKey, string>> = { ar, en };

export function translate(
  locale: Locale,
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  const template = dictionaries[locale][key] ?? dictionaries.ar[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    Object.hasOwn(vars, k) ? String(vars[k]) : m,
  );
}

/** Used by the parity test and by CI: keys present in one locale but not the other. */
export function keyParity(): { missingInEn: string[]; missingInAr: string[] } {
  const arKeys = Object.keys(ar);
  const enKeys = Object.keys(en);
  return {
    missingInEn: arKeys.filter((k) => !enKeys.includes(k)),
    missingInAr: enKeys.filter((k) => !arKeys.includes(k)),
  };
}

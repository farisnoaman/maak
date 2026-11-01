# Store listing copy — Arabic and English

Written before the store asks for it, because a listing assembled at submission time is how an app ships with a
description that promises a feature the app does not have. Every claim below is checked against the product in
`docs/uat.md`; if a line here stops being true, it is edited in the same change that made it false.

Character limits: **App Store** name 30, subtitle 30, keywords 100, description 4000. **Play** title 30, short
description 80, full description 4000.

---

## Name / title

| Field | Arabic | English |
| --- | --- | --- |
| Name | معك | Maak |
| Subtitle (iOS) | حجز رحلات بين المدن اليمنية | Intercity travel in Yemen |
| Short description (Play, ≤80) | احجز مقعدك بين المدن اليمنية، وتابع رحلتك حتى الوصول | Book a seat between Yemeni cities and follow the trip |

## Keywords (iOS, ≤100, comma-separated)

`سفر,رحلات,باص,حجز,عدن,صنعاء,تعز,حضرموت,نقل,bus,travel,Yemen,booking,trip`

## Full description — Arabic

> **معك: احجز مقعدك، وتابع رحلتك.**
>
> معك منصة يمنية تربط المسافرين بمشغّلي النقل بين المحافظات. ابحث عن رحلة، قارن الوقت والسعر، واحجز مقعدك في دقائق.
>
> **للمسافر**
> • ابحث عن الرحلات حسب المغادرة والوصول والوقت والسعر.
> • احجز مقعدك أو مقاعدك وادفع بالطريقة المتاحة للمشغّل (تحويل، أو نقدًا عند الإقلاع).
> • تابع الرحلة على الخريطة، واعرف أين وصلت ومتى تصل.
> • تصلك تذكيرات قبل ٢٤ ساعة وقبل ساعتين وقبل الإقلاع.
> • تنبيهات بحث محفوظ: نُخبرك حين تُنشر رحلة تطابق بحثك.
>
> **للمشغّل**
> • أنشئ رحلاتك، وحدّد الوجهات والتوقفات والأسعار وسياسة الحجز.
> • أدر مركباتك وسائقيك وحجوزاتك من لوحة واحدة.
> • كشف حضور لكل رحلة، ومسح تذاكر، وتقارير إيرادات.
>
> **الخصوصية أولًا**
> لا نبيع بياناتك. وثائق الهوية تُحذف بعد ٩٠ يومًا من إغلاق الحجز، وصور الإيصالات بعد ١٨٠ يومًا. يمكنك طلب حذف حسابك في أي وقت.
>
> معك ليست شركة نقل؛ الرحلات تُشغّلها شركات نقل مرخّصة ومعتمدة على المنصة.

## Full description — English

> **Maak: book your seat, follow the trip.**
>
> Maak is a Yemeni marketplace that connects passengers with intercity transport operators. Search a trip,
> compare times and prices, and book a seat in minutes.
>
> **For passengers**
> • Search by origin, destination, time and price.
> • Book one seat or several, and pay the way the operator accepts (transfer, or cash at departure).
> • Follow the trip on the map, see where it is and when it arrives.
> • Reminders 24 hours, 2 hours and at departure.
> • Saved-search alerts: we tell you when a trip matching your search is published.
>
> **For operators**
> • Create trips with stops, prices and booking policy.
> • Manage vehicles, drivers and bookings from one console.
> • Run a manifest per trip, scan tickets, and see revenue reports.
>
> **Privacy first**
> We do not sell your data. Identity documents are deleted 90 days after a booking closes, payment receipt
> images after 180 days, and you can request account deletion at any time.
>
> Maak is not a carrier: trips are operated by licensed transport companies verified on the platform.

## What's new (first release)

| Locale | Text |
| --- | --- |
| AR | الإصدار الأول: البحث والحجز، متابعة الرحلة، تنبيهات الحجز والرحلات، لوحة المشغّل. |
| EN | First release: search and booking, live trip tracking, booking and trip notifications, the operator console. |

## Store privacy answers (the two questions review always asks)

- **Data collected:** contact info (name, phone, email), identifiers (national ID / passport for verification),
  photos (identity document, payment receipt, vehicle), location (driver only, while a trip is running),
  purchase history (bookings and payments).
- **Tracking:** none. No advertising SDK, no cross-app tracking, no data broker.
- **Account deletion:** in-app, from *Account → Delete account*; executed by a platform administrator, with the
  financial ledger retained as required for accounting (`docs/admin-guide.md` §6a).

## Before submitting — the checklist nobody can do for you

1. `eas build --profile production --platform all` passes on real credentials (needs the Expo account).
2. `eas submit` needs a Play service account and an App Store Connect app id; both are placeholders in
   `apps/mobile/eas.json` until the accounts exist.
3. The two legal URLs must resolve publicly: `https://maak.test/ar/privacy`, `/en/privacy`, `/ar/terms`,
   `/en/terms`.
4. Screenshots: six per platform, Arabic first, at the sizes each store lists. Take them from a seeded staging
   build, not a developer device with test data on it.

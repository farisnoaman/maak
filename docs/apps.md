# Where the apps are

Short answer: **there is one Expo app, not two.** `apps/mobile` is the driver's and the passenger's app depending
on who signs in — the same way the web app serves every role. Every screen a role needs is listed below, with the
file that implements it. This file exists because "where is the driver app" was a fair question with no answer in
the repository.

---

## The mobile app — `apps/mobile` (Expo SDK 52, RN 0.76.5)

Installing it is covered in **"How to install it on a phone"** below — three routes, cheapest first.

### Home — `src/app/index.tsx`

One shell that routes by role. It shows the price calculation (proving `@maak/core` runs on native), then links to
everything a phone is used for:

| Link | Screen |
| --- | --- |
| My trips today (**driver**) | `src/app/driver/trips/index.tsx` |
| Driver profile / licence | `src/app/driver/profile.tsx` |
| Log fuel | `src/app/driver/fuel.tsx` |
| Search trips (**passenger**) | `src/app/trips/index.tsx` |
| My bookings | `src/app/bookings/index.tsx` |
| Notifications | `src/app/notifications.tsx` |
| Notification preferences | `src/app/notification-preferences.tsx` |

### Driver

| What they do | Screen | Commands it calls |
| --- | --- | --- |
| See the day's assigned trips | `driver/trips/index.tsx` | — (RLS read, `00024`) |
| Start the trip (odometer) | `driver/trips/[code].tsx` | `trip.start` |
| Report the position, at each stop | `driver/trips/[code].tsx` | `trip.recordPing` (via `expo-location`) |
| Mark a stop reached | `driver/trips/[code].tsx` | `trip.stopReached` |
| End the trip (odometer) | `driver/trips/[code].tsx` | `trip.end` |
| Accept an invitation, upload a licence, see the assigned vehicle | `driver/profile.tsx` | `driver.accept`, `driver.setLicence` |
| Log a fill at the pump | `driver/fuel.tsx` | `vehicle.logFuel` |
| Quick view of the assigned vehicle | `driver/vehicle/[id].tsx` | — (read) |

### Passenger

| What they do | Screen | Commands it calls |
| --- | --- | --- |
| Search with filters | `trips/index.tsx` | `search_public_trips` (RPC) |
| Open a trip | `trips/[code].tsx` | `get_trip_public` (RPC) |
| Book seats | `book/[code].tsx` | `booking.create` |
| See bookings, live status | `bookings/index.tsx`, `bookings/[id].tsx` | — (RLS read) |
| Pay, upload a receipt, see the status | `pay/[intent].tsx` | `payment.intent.create`, `payment.proof.submit` |
| Verification, account, sign-in | `verification.tsx`, `profile.tsx`, `sign-in.tsx` | `identity.*` |
| Notifications, preferences, quiet hours | `notifications.tsx`, `notification-preferences.tsx` | `notifications.*` |

### Staff (scanning) — `staff/scan.tsx`

Ticket scanning at the door, which is the one staff action that had to be on a phone.

### Push

`lib/push.ts` registers the device; `lib/push-routing.ts` opens the screen a notification's `link` names, including
on a cold start. So a "trip is running" push lands on the driver's trip screen, not on the home shell.

---

## How to install it on a phone

Three routes. The first needs nothing but a browser; the last needs store accounts that do not exist yet.

### 1. The web app, as a PWA — works today, no build, no account

`apps/web` ships a real manifest (`src/app/manifest.ts`) and a service worker (`public/sw.js`): standalone display,
generated icons, `start_url` on `/ar/trips`. On a phone:

1. open the site in Chrome (Android) or Safari (iOS);
2. *Add to Home Screen* / *تثبيت التطبيق*;
3. it launches full-screen, with the Arabic marketplace as its opening screen.

This is the honest answer to "how do I get Maak on a phone" while the stores are closed: every role — passenger,
driver trip console, operator — works in it. It needs a **hosted origin**, though: `localhost` on a phone is the
phone. Use a preview URL, or `npm run build && npm start` behind any HTTPS host, or a tunnel
(`npx localtunnel --port 3000`) for a five-minute demo.

### 2. Expo Go — the inner loop, ~2 minutes, no accounts

On the developer's machine:

```bash
cp apps/mobile/.env.example apps/mobile/.env     # then point EXPO_PUBLIC_SUPABASE_URL at your machine's LAN IP
npm install
cd apps/mobile && npx expo start
```

Install **Expo Go** from the Play Store or App Store, scan the QR code, and the app runs inside it. Same screens,
same backend.

Two limits, both real: Expo Go cannot do **remote push** (that is a development-build feature), and it needs the
Supabase URL to be reachable from the phone — `127.0.0.1` means the phone itself, so use `http://192.168.x.x:54321`
or a tunnel. The app tells you when it cannot reach the backend rather than pretending.

### 3. An installable build — an APK/IPA a tester keeps on their phone

This is what "install" normally means, and it needs an Expo account (free) and an EAS build:

```bash
npm install -g eas-cli
cd apps/mobile
eas login                     # expo.dev account, free tier is enough
eas build --profile preview --platform android
```

The build finishes with a URL; open it on the phone and install. Android installs an `.apk` directly. iOS internal
distribution needs a paid Apple Developer account and the device's UDID registered — there is no way around that.

`apps/mobile/eas.json` names an EAS *environment* per profile rather than inlining values, so the variables the app
actually reads have to exist once:

```bash
eas env:create --environment preview --name EXPO_PUBLIC_SUPABASE_URL      --value https://<project-ref>.supabase.co --visibility plaintext
eas env:create --environment preview --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value <anon key> --visibility sensitive
```

Before this, `eas.json` set `EXPO_PUBLIC_API_URL`, which **nothing in the app reads** — every profile built an app
that installed and then said "not configured". The three variables that matter are the two above plus the optional
`EXPO_PUBLIC_SITE_URL` / `EXPO_PUBLIC_WEB_URL`, and `apps/mobile/.env.example` lists them.

> The `development` profile no longer sets `developmentClient: true`. That flag needs `expo-dev-client`, which is not
> installed, and pulling it in costs **30 new audit advisories including a critical `tar` CVE** — measured, then
> reverted. If a developer wants the dev menu, run `npx expo install expo-dev-client` locally; the shipped profiles
> stay inside the Expo Go + internal-build path.

### 4. The stores — blocked on accounts, not on code

`docs/store-listing.md` has the listings, screenshots and data-safety answers ready. What is missing is the accounts:
Play Console ($25 once), Apple Developer ($99/year), and the `REPLACE_WITH_*` values in `eas.json`'s submit block.
Until then, route 3 is the way to hand someone the app.

---

---

## The web app — `apps/web` (Next.js 16)

Every role also has a full console in the browser; the phone app is the subset that belongs in a pocket.

| Role | Entry | What is there |
| --- | --- | --- |
| Passenger | `/trips`, `/account/bookings`, `/pay/[intent]` | Search, booking, payments, live trip page (`/trips/[code]/live`) |
| Driver | `/driver`, `/driver/trips/[code]` | The same four trip commands, with browser geolocation — this is the fallback if a driver has no phone app installed |
| Operator | `/operator/*` | Trips, vehicles, drivers, bookings, team, settings, payouts, expenses |
| Staff | `/staff/*`, `/admin/*` | Verification queues, trip search, manifest, scan, users and roles |
| Finance | `/finance/*` | Payments, refunds, payouts, accounts, agents, ledger, reconciliation, statements |
| Admin | `/admin/plans`, `/admin/regions`, `/admin/places`, `/admin/notifications` | Plan limits, regions, the gazetteer, the notification catalogue |

---

## What is deliberately not built

1. **Background location.** The driver taps *share position* at each stop. A 10-minute background cadence needs
   `expo-task-manager`, an Android foreground service and iOS "always" permission — a UX conversation and a battery
   conversation, not a code task. The permission strings for it were removed from `app.json` rather than left in,
   because an unused always-location permission is a store review rejection and a privacy-policy claim that is not
   true.
2. **The offline queue.** A ping sent with no signal currently fails and says so. Queueing it for later is a
   persistent store plus a replay rule, and a half-built one silently loses positions.
3. **Operator screens on mobile.** An operator works at a desk; the console is web-only on purpose.
4. **Two separate apps.** One app with two roles is one install, one push registration and one release to manage.
   If the stores ever need separate listings, that is an `app.json` per flavour and a shared `src/`, not a fork.

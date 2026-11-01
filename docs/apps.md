# Where the apps are

Short answer: **there is one Expo app, not two.** `apps/mobile` is the driver's and the passenger's app depending
on who signs in — the same way the web app serves every role. Every screen a role needs is listed below, with the
file that implements it. This file exists because "where is the driver app" was a fair question with no answer in
the repository.

---

## The mobile app — `apps/mobile` (Expo SDK 52, RN 0.76.5)

Run it: `npm install`, then `npx expo start` in `apps/mobile` (needs the Expo toolchain on the developer's machine;
the sandbox cannot run a device). Backend: `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`, and
`EXPO_PUBLIC_API_URL` is only for the development profile in `eas.json`.

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

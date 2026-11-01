#!/usr/bin/env node
/**
 * The notification worker — claim, transport, record.
 *
 * Phase 11 ships the seam and this loop; a scheduler is Phase 12's job (see `docs/phase-11-report.md`),
 * which is why the loop is a script with `--once` rather than something hidden inside a web request.
 *
 * Why it is built this way:
 *
 *   · **One write per request.** `cmd_claim_notifications` hands out due rows and marks them `sending`;
 *     each outcome is then recorded by its own request. The write guard refuses two commands in one call,
 *     and delivery is inherently two — so the worker is a loop, not a transaction.
 *   · **At-least-once, with a dedupe key.** A crash between sending and recording repeats the send; the
 *     provider-side receipt and the notification's `dedupe_key` are what keep that from becoming two
 *     messages on two phones.
 *   · **A missing provider is not a crash.** With no `EXPO_ACCESS_TOKEN` or `RESEND_API_KEY`, the delivery
 *     is recorded as skipped with the reason — visible in the health view, rather than a silent black hole.
 *
 *   MAAK_API_URL=http://127.0.0.1:54321/functions/v1 node scripts/notify-worker.mjs --once
 *   MAAK_WORKER_TOKEN=<staff jwt>  — a staff session; the cron holds a credential, not a person's cookie.
 *   EXPO_ACCESS_TOKEN / RESEND_API_KEY / MAAK_MAIL_FROM  — transport credentials, all optional.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = new Set(process.argv.slice(2));
const once = args.has('--once') || args.has('--check');
const dryRun = args.has('--dry-run') || args.has('--check');

const API_URL = (process.env.MAAK_API_URL ?? 'http://127.0.0.1:54321/functions/v1').replace(
  /\/$/,
  '',
);
const TOKEN = process.env.MAAK_WORKER_TOKEN ?? '';
const EXPO_TOKEN = process.env.EXPO_ACCESS_TOKEN ?? '';
const RESEND_KEY = process.env.RESEND_API_KEY ?? '';
const MAIL_FROM = process.env.MAAK_MAIL_FROM ?? 'notifications@maak.test';
const INTERVAL_MS = Number(process.env.MAAK_WORKER_INTERVAL_MS ?? 30_000);
const BATCH = Number(process.env.MAAK_WORKER_BATCH ?? 20);

/**
 * `@maak/core` is TypeScript, so it is bundled once the same way the dev gateway does it — one definition of
 * the notification rules for the web app, the gateway and this worker.
 */
async function loadCore() {
  const { build } = await import('esbuild');
  const outfile = join(root, '.dev', 'core.bundle.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [join(root, 'scripts', 'dev-backend', 'core-entry.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function call(action, payload) {
  const response = await fetch(`${API_URL}/dispatch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      `${action} failed: ${response.status} ${body.code ?? ''} ${body.detail ?? ''}`,
    );
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

/** Expo accepts up to 100 messages per request; a batch of 20 deliveries never needs more than one call. */
async function sendPush(messages) {
  if (!EXPO_TOKEN) return { ok: false, reason: 'provider_not_configured' };
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${EXPO_TOKEN}` },
    body: JSON.stringify(messages),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, reason: `expo: ${response.status}` };
  // Expo answers 200 with per-message errors in `data`. A ticket id means "accepted", not "delivered".
  const tickets = Array.isArray(body.data) ? body.data : [body.data];
  const first = tickets.find((ticket) => ticket?.status === 'error');
  if (first)
    return { ok: false, reason: `expo: ${first.details?.error ?? first.message ?? 'error'}` };
  return { ok: true, providerRef: tickets[0]?.id ?? null };
}

async function sendEmail(item, text, core) {
  if (!RESEND_KEY) return { ok: false, reason: 'provider_not_configured' };
  const mail = core.emailMessage(item, text, {
    appName: 'معك',
    baseUrl: process.env.MAAK_APP_URL ?? '',
  });
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [item.email],
      subject: mail.subject,
      text: mail.text,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, reason: `resend: ${response.status}` };
  return { ok: true, providerRef: body.id ?? null };
}

async function deliver(item, core) {
  const text = core.notificationText(item.locale === 'en' ? 'en' : 'ar', {
    kind: item.kind,
    titleKey: item.titleKey,
    params: item.params,
  });

  if (item.channel === 'push') {
    if (item.tokens.length === 0) return { outcome: 'skipped', error: 'no_device' };
    const appName = item.locale === 'en' ? 'Maak' : 'معك';
    const result = await sendPush(core.expoPushMessages(item, text, { appName }));
    return result.ok
      ? { outcome: 'sent', providerRef: result.providerRef }
      : { outcome: 'skipped', error: result.reason };
  }

  if (item.channel === 'email') {
    const address = item.email ?? (await lookupEmail(item.userId));
    if (!address) return { outcome: 'skipped', error: 'no_address' };
    const result = await sendEmail({ ...item, email: address }, text, core);
    return result.ok
      ? { outcome: 'sent', providerRef: result.providerRef }
      : { outcome: 'skipped', error: result.reason };
  }

  if (item.channel === 'whatsapp') {
    if (!item.phone) return { outcome: 'skipped', error: 'no_phone' };
    // A deep link is what this channel is: there is no WhatsApp Business account behind it, and recording a
    // send that never happened is how "we notified them" becomes a lie in a dispute.
    return { outcome: 'sent', providerRef: core.whatsappDeepLink(item.phone, text) };
  }

  return { outcome: 'skipped', error: 'channel_not_transportable' };
}

/**
 * Email addresses live in `auth.users`, which the database deliberately does not expose to the API surface.
 * The claim payload therefore leaves `email` null, and the worker asks the auth admin endpoint — the one
 * place a service credential is genuinely required.
 */
const emailCache = new Map();
async function lookupEmail(userId) {
  if (emailCache.has(userId)) return emailCache.get(userId);
  const url = process.env.MAAK_AUTH_URL;
  const key = process.env.MAAK_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const response = await fetch(`${url.replace(/\/$/, '')}/admin/users/${userId}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => ({}));
  const email = body.email ?? null;
  emailCache.set(userId, email);
  return email;
}

async function drain(core) {
  const claimed = await call('notifications.dispatch', { limit: BATCH });
  const items = Array.isArray(claimed.items) ? claimed.items : [];
  if (items.length === 0) return { claimed: 0, sent: 0, skipped: 0, failed: 0 };

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of items) {
    if (dryRun) {
      console.log(`· would deliver ${item.channel} to ${item.userId}: ${item.titleKey}`);
      skipped += 1;
      continue;
    }
    let result;
    try {
      result = await deliver(item, core);
    } catch (error) {
      result = { outcome: 'failed', error: String(error.message ?? error).slice(0, 400) };
    }
    if (result.outcome === 'sent') sent += 1;
    else if (result.outcome === 'failed') failed += 1;
    else skipped += 1;

    try {
      await call('notifications.delivery.record', {
        deliveryId: item.deliveryId,
        outcome: result.outcome,
        error: result.error ?? null,
        providerRef: result.providerRef ?? null,
      });
    } catch (error) {
      // A record that fails leaves the row `sending`; the ten-minute rescue in `cmd_claim_notifications`
      // picks it up again. Retrying here would double-record.
      console.error(`! could not record ${item.deliveryId}: ${error.message}`);
    }
  }

  return { claimed: items.length, sent, skipped, failed };
}

/** One pass over the six jobs. Every one is idempotent, so a slow or doubled cron is harmless. */
async function runJobs() {
  const jobs = [
    'saved-searches',
    'trip-reminders',
    'quota',
    'expiring',
    'verification-sla',
    'retry',
  ];
  const results = {};
  for (const job of jobs) {
    try {
      results[job] = await call('notifications.job.run', { job });
    } catch (error) {
      results[job] = { error: error.message };
    }
  }
  return results;
}

async function main() {
  const core = await loadCore();

  if (args.has('--check')) {
    console.log('notifications worker: configuration');
    console.log(`· api            ${API_URL}`);
    console.log(`· staff token    ${TOKEN ? 'set' : 'MISSING (MAAK_WORKER_TOKEN)'}`);
    console.log(
      `· expo           ${EXPO_TOKEN ? 'set' : 'not set — pushes will be recorded as skipped'}`,
    );
    console.log(
      `· resend         ${RESEND_KEY ? 'set' : 'not set — emails will be recorded as skipped'}`,
    );
    const core = await loadCore();
    console.log(`· contract       ${Object.keys(core.NOTIFICATION_JOB_FN).length} jobs wired`);
    console.log(`· batch          ${BATCH} deliveries per claim`);
    return;
  }

  for (;;) {
    const drained = await drain(core);
    const jobs = await runJobs();
    console.log(JSON.stringify({ at: new Date().toISOString(), drained, jobs }));
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/**
 * verification-queue — the staff console's only read of private verification data.
 *
 * Why a function instead of a plain table read? The documents live in a **private** bucket, so the
 * console needs short-lived signed URLs. Minting those requires the service role, and the service
 * role must never be exposed to a browser. Staff-only, and every document URL expires in minutes.
 */

import { can, verificationQueueSchema, type VerificationQueueItem } from '@maak/core';
import { defineCommand } from '../_shared/handler.ts';
import { serviceClient } from '../_shared/auth.ts';
import { forbidden, internal } from '../_shared/errors.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';
import { recordDenied } from '../_shared/audit.ts';

interface RequestRow {
  id: string;
  subject_type: 'individual' | 'organization';
  subject_id: string;
  requested_by: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  note: string | null;
  snapshot: Record<string, unknown>;
  created_at: string;
}

interface DocumentRow {
  id: string;
  request_id: string;
  kind: string;
  storage_path: string;
}

const SIGNED_URL_TTL_SECONDS = 300;

export default defineCommand({ schema: verificationQueueSchema }, async (ctx) => {
  if (!can(ctx.resolved.actor, 'verification.decide')) {
    await recordDenied({
      actorId: ctx.resolved.actor.userId,
      action: 'verification.queue',
      entityType: 'verification_request',
      reason: 'FORBIDDEN',
      requestId: ctx.requestId,
      ip: ctx.ip,
    });
    throw forbidden('Staff only');
  }

  const { actor } = ctx.resolved;
  await enforceRateLimit(actor.userId as string, 'verification.queue', {
    limit: 120,
    windowSeconds: 60,
  });

  const client = serviceClient();
  const input = ctx.input;

  let query = client
    .from('verification_requests')
    .select('id, subject_type, subject_id, requested_by, status, note, snapshot, created_at')
    .order('created_at', { ascending: true })
    .limit(input.limit);

  if (input.status !== 'all') query = query.eq('status', input.status);
  if (input.subjectType !== 'all') query = query.eq('subject_type', input.subjectType);

  const { data, error } = await query;
  if (error) throw internal(error.message);

  const rows = (data ?? []) as RequestRow[];
  if (rows.length === 0) return { items: [], requestId: ctx.requestId };

  const individualIds = rows
    .filter((r) => r.subject_type === 'individual')
    .map((r) => r.subject_id);
  const organizationIds = rows
    .filter((r) => r.subject_type === 'organization')
    .map((r) => r.subject_id);

  const [profiles, organizations, documents] = await Promise.all([
    individualIds.length
      ? client.from('profiles').select('id, full_name').in('id', individualIds)
      : Promise.resolve({ data: [], error: null }),
    organizationIds.length
      ? client.from('organizations').select('id, name').in('id', organizationIds)
      : Promise.resolve({ data: [], error: null }),
    client
      .from('verification_documents')
      .select('id, request_id, kind, storage_path')
      .in(
        'request_id',
        rows.map((r) => r.id),
      ),
  ]);

  if (documents.error) throw internal(documents.error.message);

  const nameById = new Map<string, string>();
  for (const profile of (profiles.data ?? []) as { id: string; full_name: string | null }[]) {
    nameById.set(profile.id, profile.full_name ?? '');
  }
  for (const org of (organizations.data ?? []) as { id: string; name: string }[]) {
    nameById.set(org.id, org.name);
  }

  const docRows = (documents.data ?? []) as DocumentRow[];
  const paths = docRows.map((doc) => doc.storage_path);
  const signed =
    paths.length > 0
      ? await client.storage
          .from('verification-docs')
          .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)
      : { data: [], error: null };

  const urlByPath = new Map<string, string | null>();
  for (const item of (signed.data ?? []) as { path: string | null; signedUrl: string }[]) {
    if (item.path) urlByPath.set(item.path, item.signedUrl);
  }

  const items: VerificationQueueItem[] = rows.map((row) => ({
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    requestedBy: row.requested_by,
    subjectName: nameById.get(row.subject_id) || null,
    status: row.status,
    createdAt: row.created_at,
    note: row.note,
    snapshot: row.snapshot ?? {},
    documents: docRows
      .filter((doc) => doc.request_id === row.id)
      .map((doc) => ({
        id: doc.id,
        kind: doc.kind,
        url: urlByPath.get(doc.storage_path) ?? null,
      })),
  }));

  return { items, requestId: ctx.requestId };
});

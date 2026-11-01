'use client';

import { useMemo, useState } from 'react';
import {
  errorKey,
  geoCommandSpec,
  supervisorScope,
  translate,
  type Locale,
  type RegionNode,
  type TranslationKey,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { getApiClient } from '@/lib/api';
import type { GeoDirectory, GeoSupervisor } from '@/lib/geo-types';

/**
 * Supervisor assignment.
 *
 * The district count shown next to each supervisor is computed with `supervisorScope()` — the same
 * expansion the database performs (`app.geo_scope_districts`). Listing the *regions* and showing the
 * resulting *districts* is what makes revocation obvious: uncheck a region, and the count drops.
 */
export function SupervisorPanel({
  locale,
  directory,
}: {
  readonly locale: Locale;
  readonly directory: GeoDirectory;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [supervisors, setSupervisors] = useState<readonly GeoSupervisor[]>(directory.supervisors);
  const [userId, setUserId] = useState<string>(directory.users[0]?.id ?? '');
  const [regionIds, setRegionIds] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState<'assign' | 'revoke' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nodes: RegionNode[] = useMemo(
    () =>
      directory.regions.map((region) => ({
        id: region.id,
        parentId: region.parentId,
        nameAr: region.nameAr,
        nameEn: region.nameEn,
        kind: region.kind,
        coverage: { governorateIds: region.governorateIds, districtIds: region.districtIds },
      })),
    [directory.regions],
  );

  const projected = supervisorScope(nodes, regionIds, directory.districts).length;

  function toggle(id: string) {
    setRegionIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  // Selecting a supervisor loads their current regions into the checkboxes. Without this the form
  // would look empty while a reconcile-style command silently revoked everything not re-checked.
  function selectUser(nextUserId: string) {
    setUserId(nextUserId);
    setRegionIds(supervisors.find((row) => row.userId === nextUserId)?.regionIds ?? []);
    setMessage(null);
    setError(null);
  }

  async function submit(kind: 'assign' | 'revoke') {
    setError(null);
    setMessage(null);
    if (kind === 'assign' && regionIds.length === 0) {
      setError(t('geo.coverageEmpty'));
      return;
    }

    const next: GeoSupervisor = {
      userId,
      name: directory.users.find((user) => user.id === userId)?.name ?? null,
      regionIds,
      districtCount: projected,
    };

    if (!directory.configured) {
      setSupervisors((current) =>
        kind === 'assign'
          ? [...current.filter((row) => row.userId !== userId), next]
          : current.filter((row) => row.userId !== userId),
      );
      if (kind === 'revoke') setRegionIds([]);
      setMessage(t('geo.previewNotice'));
      return;
    }

    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }

    setBusy(kind);
    const result =
      kind === 'assign'
        ? await client.call(geoCommandSpec, {
            action: 'geo.assignSupervisor',
            userId,
            regionIds: [...regionIds],
          })
        : await client.call(geoCommandSpec, { action: 'geo.revokeSupervisor', userId });
    setBusy(null);

    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }

    setSupervisors((current) =>
      kind === 'assign'
        ? [...current.filter((row) => row.userId !== userId), next]
        : current.filter((row) => row.userId !== userId),
    );
    if (kind === 'revoke') setRegionIds([]);
    setMessage(t('supervisors.assigned'));
  }

  const current = supervisors.find((row) => row.userId === userId);

  return (
    <section className="console-section" aria-labelledby="geo-supervisors">
      <div className="panel-head">
        <h2 id="geo-supervisors">{t('supervisors.title')}</h2>
        <Badge tone="info">{t('supervisors.scope')}</Badge>
      </div>
      <p className="form-hint">{t('supervisors.subtitle')}</p>

      {supervisors.length === 0 ? (
        <p className="form-hint">{t('supervisors.none')}</p>
      ) : (
        <ul className="queue-list">
          {supervisors.map((row) => (
            <li key={row.userId} className="queue-card">
              <div>
                <p className="unit-title">{row.name ?? row.userId}</p>
                <p className="unit-meta">
                  {row.regionIds
                    .map((id) => {
                      const region = directory.regions.find((candidate) => candidate.id === id);
                      return region ? (locale === 'ar' ? region.nameAr : region.nameEn) : id;
                    })
                    .join(' · ')}
                </p>
              </div>
              <Badge tone="success">{t('geo.districtCount', { count: row.districtCount })}</Badge>
            </li>
          ))}
        </ul>
      )}

      <div className="form-grid">
        <Select
          label={t('supervisors.user')}
          value={userId}
          onChange={(event) => selectUser(event.target.value)}
          options={
            directory.users.length === 0
              ? [{ value: '', label: t('supervisors.selectUser'), disabled: true }]
              : directory.users.map((user) => ({
                  value: user.id,
                  label: user.name ?? user.id,
                }))
          }
        />
      </div>

      <fieldset className="geo-coverage">
        <legend>{t('supervisors.regions')}</legend>
        <div className="geo-check-grid">
          {directory.regions.map((region) => (
            <label key={region.id} className="geo-check">
              <input
                type="checkbox"
                checked={regionIds.includes(region.id)}
                onChange={() => toggle(region.id)}
              />
              <span>{locale === 'ar' ? region.nameAr : region.nameEn}</span>
            </label>
          ))}
        </div>
        <p className="form-hint" aria-live="polite">
          {t('supervisors.scope')}: {projected}
        </p>
      </fieldset>

      <div className="form-actions">
        <Button
          variant="primary"
          onClick={() => submit('assign')}
          disabled={busy !== null || !userId}
          loading={busy === 'assign'}
        >
          {t('supervisors.assign')}
        </Button>
        <Button
          variant="danger"
          onClick={() => submit('revoke')}
          disabled={busy !== null || !userId || !current}
          loading={busy === 'revoke'}
        >
          {t('supervisors.revoke')}
        </Button>
      </div>

      {message ? (
        <p className="form-success" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

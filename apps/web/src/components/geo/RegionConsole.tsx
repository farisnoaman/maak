'use client';

import { useMemo, useState } from 'react';
import {
  descendantRegionIds,
  errorKey,
  expandCoverage,
  geoCommandSpec,
  translate,
  validateCoverage,
  type Locale,
  type RegionNode,
  type TranslationKey,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { getApiClient } from '@/lib/api';
import type { GeoDirectory, GeoRegion } from '@/lib/geo-types';

interface Draft {
  readonly id: string | null;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly kind: 'region' | 'sub_region';
  readonly parentId: string | null;
  readonly governorateIds: readonly string[];
  readonly districtIds: readonly string[];
}

const EMPTY_DRAFT: Draft = {
  id: null,
  nameAr: '',
  nameEn: '',
  kind: 'region',
  parentId: null,
  governorateIds: [],
  districtIds: [],
};

function toNodes(regions: readonly GeoRegion[]): RegionNode[] {
  return regions.map((region) => ({
    id: region.id,
    parentId: region.parentId,
    nameAr: region.nameAr,
    nameEn: region.nameEn,
    kind: region.kind,
    coverage: { governorateIds: region.governorateIds, districtIds: region.districtIds },
  }));
}

/**
 * Region builder.
 *
 * Coverage is *validated before it is submitted* with the same function the SQL command mirrors:
 * a district can only be added under a governorate the region already covers, so the form cannot
 * produce the `DISTRICT_OUTSIDE_GOVERNORATE` error the command would reject.
 */
export function RegionConsole({
  locale,
  directory,
}: {
  readonly locale: Locale;
  readonly directory: GeoDirectory;
}) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [regions, setRegions] = useState<readonly GeoRegion[]>(directory.regions);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nodes = useMemo(() => toNodes(regions), [regions]);
  const districtById = useMemo(
    () => new Map(directory.districts.map((district) => [district.id, district])),
    [directory.districts],
  );

  const problems = validateCoverage(
    { governorateIds: draft.governorateIds, districtIds: draft.districtIds },
    directory.governorates,
    directory.districts,
  );
  const covered = expandCoverage(
    { governorateIds: draft.governorateIds, districtIds: draft.districtIds },
    directory.districts,
  );

  // A region cannot become its own descendant's child: the command would reject it, so the select
  // does not offer it in the first place.
  const forbiddenParents = draft.id
    ? new Set([draft.id, ...descendantRegionIds(nodes, draft.id)])
    : new Set<string>();
  const parentOptions = [
    { value: '', label: t('geo.parentNone') },
    ...regions
      .filter((region) => !forbiddenParents.has(region.id))
      .map((region) => ({
        value: region.id,
        label: locale === 'ar' ? region.nameAr : region.nameEn,
      })),
  ];

  const visibleDistricts = directory.districts.filter((district) =>
    draft.governorateIds.includes(district.governorateId),
  );

  function toggle(list: readonly string[], id: string): string[] {
    return list.includes(id) ? list.filter((value) => value !== id) : [...list, id];
  }

  function startEdit(region: GeoRegion) {
    setDraft({
      id: region.id,
      nameAr: region.nameAr,
      nameEn: region.nameEn,
      kind: region.kind,
      parentId: region.parentId,
      governorateIds: region.governorateIds,
      districtIds: region.districtIds,
    });
    setMessage(null);
    setError(null);
  }

  async function save() {
    if (problems.length > 0) {
      setError(t('geo.coverageEmpty'));
      return;
    }
    setError(null);
    setMessage(null);

    const nextRegion: GeoRegion = {
      id: draft.id ?? `preview-${Date.now()}`,
      parentId: draft.parentId,
      kind: draft.kind,
      nameAr: draft.nameAr.trim(),
      nameEn: draft.nameEn.trim(),
      governorateIds: draft.governorateIds,
      districtIds: draft.districtIds,
    };

    if (!directory.configured) {
      setRegions((current) =>
        draft.id
          ? current.map((region) => (region.id === draft.id ? nextRegion : region))
          : [...current, nextRegion],
      );
      setDraft(EMPTY_DRAFT);
      setMessage(t('geo.previewNotice'));
      return;
    }

    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }

    setBusy(true);
    const result = await client.call(geoCommandSpec, {
      action: 'region.upsert',
      regionId: draft.id ?? undefined,
      parentId: draft.parentId,
      kind: draft.kind,
      nameAr: nextRegion.nameAr,
      nameEn: nextRegion.nameEn,
      governorateIds: [...draft.governorateIds],
      districtIds: [...draft.districtIds],
    });
    setBusy(false);

    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setRegions((current) =>
      draft.id
        ? current.map((region) => (region.id === draft.id ? nextRegion : region))
        : [...current, nextRegion],
    );
    setDraft(EMPTY_DRAFT);
    setMessage(t('geo.saved'));
  }

  return (
    <div className="geo-console">
      <section className="card" aria-labelledby="geo-region-list">
        <div className="panel-head">
          <h2 id="geo-region-list">{t('geo.title')}</h2>
          <Badge tone="info">{t('geo.depthWarning')}</Badge>
        </div>

        {regions.length === 0 ? (
          <p className="form-hint">{t('geo.noRegions')}</p>
        ) : (
          <ul className="queue-list" aria-label={t('geo.title')}>
            {regions.map((region) => {
              const parent = regions.find((candidate) => candidate.id === region.parentId);
              const districts = expandCoverage(
                { governorateIds: region.governorateIds, districtIds: region.districtIds },
                directory.districts,
              );
              return (
                <li key={region.id} className="queue-card">
                  <div>
                    <p style={{ fontWeight: 700, margin: 0 }}>
                      {locale === 'ar' ? region.nameAr : region.nameEn}
                      {parent ? (
                        <span className="form-hint">
                          {' '}
                          · {locale === 'ar' ? parent.nameAr : parent.nameEn}
                        </span>
                      ) : null}
                    </p>
                    <p className="form-hint" style={{ margin: 0 }}>
                      {t('geo.districtCount', { count: districts.length })} ·{' '}
                      {region.governorateIds.length} {t('geo.governorates')}
                    </p>
                  </div>
                  <div className="geo-row-actions">
                    <Badge tone={region.kind === 'region' ? 'info' : 'warning'}>
                      {region.kind === 'region' ? t('geo.kindRegion') : t('geo.kindSubRegion')}
                    </Badge>
                    <Button variant="subtle" size="sm" onClick={() => startEdit(region)}>
                      {t('geo.editRegion')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="geo-region-form">
        <div className="panel-head">
          <h2 id="geo-region-form">{draft.id ? t('geo.editRegion') : t('geo.newRegion')}</h2>
          <Button variant="ghost" size="sm" onClick={() => setDraft(EMPTY_DRAFT)}>
            {t('common.cancel')}
          </Button>
        </div>

        <div className="form-grid">
          <Field
            label={t('geo.nameAr')}
            required
            value={draft.nameAr}
            onChange={(event) => setDraft({ ...draft, nameAr: event.target.value })}
          />
          <Field
            label={t('geo.nameEn')}
            required
            dir="ltr"
            value={draft.nameEn}
            onChange={(event) => setDraft({ ...draft, nameEn: event.target.value })}
          />
          <Select
            label={t('geo.kind')}
            value={draft.kind}
            onChange={(event) =>
              setDraft({ ...draft, kind: event.target.value as 'region' | 'sub_region' })
            }
            options={[
              { value: 'region', label: t('geo.kindRegion') },
              { value: 'sub_region', label: t('geo.kindSubRegion') },
            ]}
          />
          <Select
            label={t('geo.parent')}
            value={draft.parentId ?? ''}
            onChange={(event) => setDraft({ ...draft, parentId: event.target.value || null })}
            options={parentOptions}
          />
        </div>

        <fieldset className="geo-coverage">
          <legend>{t('geo.coverage')}</legend>
          <p className="form-hint">{t('geo.coverageHint')}</p>

          <div className="geo-check-grid">
            {directory.governorates.map((governorate) => {
              const checked = draft.governorateIds.includes(governorate.id);
              return (
                <label key={governorate.id} className="geo-check">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const governorateIds = toggle(draft.governorateIds, governorate.id);
                      // Removing a governorate must drop its hand-picked districts too, or the
                      // selection would be invalid the moment it is submitted.
                      const districtIds = checked
                        ? draft.districtIds.filter(
                            (id) => districtById.get(id)?.governorateId !== governorate.id,
                          )
                        : draft.districtIds;
                      setDraft({ ...draft, governorateIds, districtIds });
                    }}
                  />
                  <span>{locale === 'ar' ? governorate.nameAr : governorate.nameEn}</span>
                  <span className="form-hint">{governorate.code}</span>
                </label>
              );
            })}
          </div>

          {visibleDistricts.length > 0 ? (
            <div className="geo-check-grid" aria-label={t('geo.districts')}>
              {visibleDistricts.map((district) => (
                <label key={district.id} className="geo-check">
                  <input
                    type="checkbox"
                    checked={draft.districtIds.includes(district.id)}
                    onChange={() =>
                      setDraft({ ...draft, districtIds: toggle(draft.districtIds, district.id) })
                    }
                  />
                  <span>{locale === 'ar' ? district.nameAr : district.nameEn}</span>
                </label>
              ))}
            </div>
          ) : null}

          <p className="form-hint" aria-live="polite">
            {t('geo.districtCount', { count: covered.length })}
          </p>
        </fieldset>

        <div className="form-actions">
          <Button variant="primary" onClick={save} disabled={busy}>
            {t('common.save')}
          </Button>
        </div>

        {message ? (
          <p className="form-success" role="status">
            {message}
          </p>
        ) : null}
        {error || problems.some((problem) => problem.code !== 'EMPTY') ? (
          <p className="form-error" role="alert">
            {error ?? t('geo.coverageEmpty')}
          </p>
        ) : null}
      </section>
    </div>
  );
}

'use client';

import { useMemo, useState } from 'react';
import {
  descendantRegionIds,
  errorKey,
  expandCoverage,
  geoCommandSpec,
  translate,
  translateCount,
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
  readonly description: string;
  readonly kind: 'region' | 'sub_region';
  readonly parentId: string | null;
  readonly governorateIds: readonly string[];
  readonly districtIds: readonly string[];
}

const EMPTY_DRAFT: Draft = {
  id: null,
  nameAr: '',
  nameEn: '',
  description: '',
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
 * Region builder — two cards, not one long column.
 *
 * The page used to be a stack of loose blocks: a card per region, then a bare form, then two fieldsets holding 22
 * governorate checkboxes and a district grid. Everything was the same weight, so nothing told the reader where the
 * tree ended and the editor began, and on a phone the editor started below the fold of its own heading. It is now a
 * tree card beside an editor card: the structure on the left, the thing being built on the right, each with its own
 * labelled groups (identity, coverage) and one line of consequence at the foot of the editor.
 *
 * Coverage is the **union** of whole governorates and hand-picked districts, and a hand-picked district may come from
 * any governorate — that is the «6 governorates + 4 extra districts» case in the spec. The two lists are therefore
 * edited independently:
 *
 *   · the governorate checkboxes select *whole governorates*;
 *   · the district panel selects *individual districts*, filtered by a governorate that is only a browsing aid and
 *     never restricts what may be stored.
 *
 * `validateCoverage()` (the same predicate the SQL command mirrors) decides what can be submitted; duplicates are
 * collapsed by `expandCoverage()`, not treated as errors.
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
  const [districtFilter, setDistrictFilter] = useState<string>('');
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

  const activeRegions = regions.filter((region) => region.isActive);
  const retiredRegions = regions.filter((region) => !region.isActive);

  /**
   * The tree in reading order: each region followed by its children, indented. The list was flat — a sub-region sat
   * in the same column as its parent with the parent's name appended as a hint, which is a sentence where an indent
   * would do. A region whose parent was retired is drawn at the top level, because that is where it now behaves.
   */
  const treeRows = useMemo(() => {
    const activeIds = new Set(activeRegions.map((region) => region.id));
    const childrenOf = new Map<string | null, GeoRegion[]>();
    for (const region of activeRegions) {
      const parentId = region.parentId && activeIds.has(region.parentId) ? region.parentId : null;
      const bucket = childrenOf.get(parentId) ?? [];
      bucket.push(region);
      childrenOf.set(parentId, bucket);
    }
    const rows: { region: GeoRegion; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const region of childrenOf.get(parentId) ?? []) {
        rows.push({ region, depth });
        if (depth < 2) walk(region.id, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  }, [activeRegions]);

  // A region cannot become its own descendant's child: the command would reject it, so the select does not offer it.
  const forbiddenParents = draft.id
    ? new Set([draft.id, ...descendantRegionIds(nodes, draft.id)])
    : new Set<string>();
  const parentOptions = [
    { value: '', label: t('geo.parentNone') },
    ...activeRegions
      .filter((region) => !forbiddenParents.has(region.id))
      .map((region) => ({
        value: region.id,
        label: locale === 'ar' ? region.nameAr : region.nameEn,
      })),
  ];

  // Browsing filter for the district panel. Defaults to the first covered governorate so the panel is immediately
  // useful, then follows the admin's choice.
  const effectiveFilter =
    districtFilter || draft.governorateIds[0] || directory.governorates[0]?.id || '';
  const filteredDistricts = directory.districts.filter(
    (district) => district.governorateId === effectiveFilter,
  );
  const filterGovernorate = directory.governorates.find(
    (governorate) => governorate.id === effectiveFilter,
  );
  const wholeGovernorateSelected = draft.governorateIds.includes(effectiveFilter);
  const extraDistricts = draft.districtIds.filter((id) => {
    const district = districtById.get(id);
    return district ? !draft.governorateIds.includes(district.governorateId) : false;
  });

  /**
   * Counts that read as sentences.
   *
   * `translateCount` picks `geo.districtCount.one` / `.two` / `.few` and falls back to `geo.districtCount` — which is
   * the 11+ form — so Arabic gets its dual (مديريتان) and its broken plural (10 مديريات) instead of «1 extra
   * districts», which is what the page printed before.
   */
  const districtsLabel = (count: number) => translateCount(locale, 'geo.districtCount', count);
  const governoratesLabel = (count: number) =>
    translateCount(locale, 'geo.governorateCount', count);
  const extraLabel = (count: number) => translateCount(locale, 'geo.extraCount', count);

  const nameOf = (region: GeoRegion) => (locale === 'ar' ? region.nameAr : region.nameEn);
  const editing = regions.find((region) => region.id === draft.id) ?? null;

  function toggle(list: readonly string[], id: string): string[] {
    return list.includes(id) ? list.filter((value) => value !== id) : [...list, id];
  }

  function startEdit(region: GeoRegion) {
    setDraft({
      id: region.id,
      nameAr: region.nameAr,
      nameEn: region.nameEn,
      description: '',
      kind: region.kind,
      parentId: region.parentId,
      governorateIds: region.governorateIds,
      districtIds: region.districtIds,
    });
    setMessage(null);
    setError(null);
    // On a phone the editor is below the tree; editing a region has to bring it into view or the tap looks ignored.
    if (typeof document !== 'undefined') {
      document.getElementById('geo-region-form')?.scrollIntoView({ block: 'start' });
    }
  }

  async function setActive(region: GeoRegion, active: boolean) {
    setError(null);
    setMessage(null);

    if (!directory.configured) {
      setRegions((current) =>
        current.map((row) => (row.id === region.id ? { ...row, isActive: active } : row)),
      );
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
      action: 'region.setActive',
      regionId: region.id,
      active,
    });
    setBusy(false);

    if (!result.ok) {
      // The command refuses while active sub-regions depend on it; say so instead of failing flat.
      setError(
        result.error.code === 'CONFLICT'
          ? t('geo.deactivateBlocked')
          : t(errorKey(result.error.code)),
      );
      return;
    }

    // The row stays, flagged: a retired region must remain reachable to be brought back.
    setRegions((current) =>
      current.map((row) => (row.id === region.id ? { ...row, isActive: active } : row)),
    );
    if (!active && draft.id === region.id) setDraft(EMPTY_DRAFT);
    setMessage(active ? t('geo.reactivated') : t('geo.deactivated'));
  }

  async function save() {
    if (problems.length > 0) {
      setError(t('geo.coverageEmpty'));
      return;
    }
    if (draft.kind === 'sub_region' && !draft.parentId) {
      setError(t('geo.subRegionNeedsParent'));
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
      isActive: true,
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
      description: draft.description.trim() || undefined,
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
    <div className="geo-page">
      <section className="geo-card" aria-labelledby="geo-region-list">
        <div className="geo-card__head">
          <div>
            <h2 id="geo-region-list">{t('geo.treeHeading')}</h2>
            <p className="form-hint">{t('geo.depthWarning')}</p>
          </div>
        </div>

        {activeRegions.length === 0 ? (
          <p className="form-hint">{t('geo.noRegions')}</p>
        ) : (
          <ul className="geo-tree" aria-label={t('geo.title')}>
            {treeRows.map(({ region, depth }) => {
              const districts = expandCoverage(
                { governorateIds: region.governorateIds, districtIds: region.districtIds },
                directory.districts,
              );
              const extra = region.districtIds.filter((id) => {
                const district = districtById.get(id);
                return district ? !region.governorateIds.includes(district.governorateId) : false;
              });
              return (
                <li
                  key={region.id}
                  className="geo-tree__row"
                  data-depth={depth}
                  data-editing={draft.id === region.id ? 'true' : undefined}
                >
                  <div className="geo-tree__main">
                    <p className="geo-tree__name">
                      <span>{nameOf(region)}</span>
                      <Badge tone={region.kind === 'region' ? 'info' : 'warning'}>
                        {region.kind === 'region' ? t('geo.kindRegion') : t('geo.kindSubRegion')}
                      </Badge>
                    </p>
                    <p className="geo-tree__meta">
                      {districtsLabel(districts.length)}
                      {' · '}
                      {governoratesLabel(region.governorateIds.length)}
                      {extra.length > 0 ? ` · ${extraLabel(extra.length)}` : ''}
                    </p>
                  </div>
                  <div className="geo-tree__actions">
                    <Button variant="subtle" size="sm" onClick={() => startEdit(region)}>
                      {t('geo.editRegion')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setActive(region, false)}
                    >
                      {t('geo.deactivate')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {retiredRegions.length > 0 ? (
          <div className="geo-tree__retired">
            <p className="geo-group__label">
              {t('geo.retired')}
              <span className="geo-group__count">{retiredRegions.length}</span>
            </p>
            <ul className="geo-tree geo-tree--retired" aria-label={t('geo.retired')}>
              {retiredRegions.map((region) => (
                <li key={region.id} className="geo-tree__row" data-retired="true">
                  <div className="geo-tree__main">
                    <p className="geo-tree__name">
                      <span>{nameOf(region)}</span>
                      <Badge tone="neutral">{t('geo.retired')}</Badge>
                    </p>
                    <p className="geo-tree__meta">{t('geo.retiredHint')}</p>
                  </div>
                  <div className="geo-tree__actions">
                    <Button variant="subtle" size="sm" onClick={() => setActive(region, true)}>
                      {t('geo.reactivate')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="geo-card geo-editor" aria-labelledby="geo-region-form">
        <div className="geo-card__head">
          <div>
            <h2 id="geo-region-form">{draft.id ? t('geo.editRegion') : t('geo.newRegion')}</h2>
            <p className="form-hint">{editing ? nameOf(editing) : t('geo.newRegionHint')}</p>
          </div>
          {draft.id ? (
            <Button variant="ghost" size="sm" onClick={() => setDraft(EMPTY_DRAFT)}>
              {t('common.cancel')}
            </Button>
          ) : null}
        </div>

        <div className="geo-group">
          <p className="geo-group__label">{t('geo.groupIdentity')}</p>
          <div className="geo-fields">
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
              hint={draft.kind === 'sub_region' ? t('geo.subRegionNeedsParent') : undefined}
            />
            <div className="geo-fields__wide">
              <Field
                label={t('geo.description')}
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </div>
          </div>
        </div>

        <div className="geo-group">
          <p className="geo-group__label">
            {t('geo.groupCoverage')}
            <span className="geo-group__count">
              {t('geo.selectedCount', {
                count: draft.governorateIds.length,
                total: directory.governorates.length,
              })}
            </span>
          </p>
          <p className="form-hint">{t('geo.coverageHint')}</p>

          <div className="geo-check-grid">
            {directory.governorates.map((governorate) => (
              <label key={governorate.id} className="geo-check">
                <input
                  type="checkbox"
                  checked={draft.governorateIds.includes(governorate.id)}
                  onChange={() =>
                    setDraft({
                      ...draft,
                      governorateIds: toggle(draft.governorateIds, governorate.id),
                    })
                  }
                />
                <span className="geo-check__name">
                  {locale === 'ar' ? governorate.nameAr : governorate.nameEn}
                </span>
                <span className="geo-check__code">{governorate.code}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="geo-group">
          <p className="geo-group__label">
            {t('geo.extraDistricts')}
            <span className="geo-group__count">
              {translateCount(locale, 'geo.extraChosen', extraDistricts.length)}
            </span>
          </p>
          <p className="form-hint">{t('geo.extraDistrictsHint')}</p>

          <Select
            label={t('geo.districtFilter')}
            value={effectiveFilter}
            onChange={(event) => setDistrictFilter(event.target.value)}
            options={directory.governorates.map((governorate) => ({
              value: governorate.id,
              label: locale === 'ar' ? governorate.nameAr : governorate.nameEn,
            }))}
          />

          <div className="geo-check-grid" aria-label={t('geo.districts')}>
            {filteredDistricts.map((district) => (
              <label key={district.id} className="geo-check">
                <input
                  type="checkbox"
                  checked={draft.districtIds.includes(district.id)}
                  onChange={() =>
                    setDraft({ ...draft, districtIds: toggle(draft.districtIds, district.id) })
                  }
                />
                <span className="geo-check__name">
                  {locale === 'ar' ? district.nameAr : district.nameEn}
                </span>
                {wholeGovernorateSelected ? (
                  <span className="geo-check__code">{t('geo.alreadyCovered')}</span>
                ) : null}
              </label>
            ))}
          </div>
          {filteredDistricts.length === 0 ? (
            <p className="form-hint">
              {t('geo.noDistricts')} {filterGovernorate ? `(${filterGovernorate.code})` : ''}
            </p>
          ) : null}
        </div>

        <div className="geo-editor__foot">
          <p className="geo-editor__recap" aria-live="polite">
            {districtsLabel(covered.length)}
            {' · '}
            {governoratesLabel(draft.governorateIds.length)}
            {extraDistricts.length > 0 ? ` · ${extraLabel(extraDistricts.length)}` : ''}
          </p>
          <Button variant="primary" onClick={save} disabled={busy} loading={busy}>
            {t('common.save')}
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
    </div>
  );
}

'use client';

import { useMemo, useRef, useState } from 'react';
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
import { Badge, EmptyState } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { DirectionalIcon } from '@/components/ui/DirectionalIcon';
import { Icon } from '@/components/ui/Icon';
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
 * Region builder: a list, and an editor that takes the list's place.
 *
 * The screen is **flat**. The previous version boxed the tree and the form in two large cards, which put a frame
 * around the whole page and left the short list answering a very tall form across the gutter — two panels competing
 * for one job. A console screen is a page: a heading, a table, the way in and the way out. The only frame on screen
 * is the one the browser window gives you, the table's rows separate themselves, and editing is a *view* — the list
 * steps aside for the editor and comes back when you are done — so the form never sits in the corner of a page it is
 * not about.
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

  /**
   * Counts that read as sentences. `translateCount` picks `geo.districtCount.one` / `.two` / `.few` and falls back to
   * `geo.districtCount` — the 11+ form — so Arabic gets its dual and its broken plural instead of «1 extra districts».
   */
  const districtsLabel = (count: number) => translateCount(locale, 'geo.districtCount', count);
  const governoratesLabel = (count: number) =>
    translateCount(locale, 'geo.governorateCount', count);
  const extraLabel = (count: number) => translateCount(locale, 'geo.extraCount', count);

  const [regions, setRegions] = useState<readonly GeoRegion[]>(directory.regions);
  /* The list is the screen; the editor is a view over it. `open` closes with Save or Cancel and never lingers. */
  const [open, setOpen] = useState(false);
  /* The editor is a disclosure row, so it is opened imperatively — `<details open>` is the user's attribute, and a
     React-controlled one fights every tap. The ref is the one exception the house rule allows. */
  const editorRef = useRef<HTMLDetailsElement | null>(null);
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
   * The list in reading order: each region followed by its children, indented in the first cell. The old list was
   * flat — a sub-region sat in the same column as its parent with the parent's name appended as a hint, which is a
   * sentence where an indent would do. A region whose parent was retired is drawn at the top level, because that is
   * where it now behaves.
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

  const nameOf = (region: GeoRegion) => (locale === 'ar' ? region.nameAr : region.nameEn);
  const editing = regions.find((region) => region.id === draft.id) ?? null;

  function toggle(list: readonly string[], id: string): string[] {
    return list.includes(id) ? list.filter((value) => value !== id) : [...list, id];
  }

  /** Open the editor and put the reader in it: the heading takes focus, so a keyboard or a screen reader lands there. */
  function openEditor(next: Draft) {
    setDraft(next);
    setOpen(true);
    setMessage(null);
    setError(null);
    requestAnimationFrame(() => {
      const panel = editorRef.current;
      if (!panel) return;
      panel.open = true;
      panel.scrollIntoView({ block: 'start' });
      panel.querySelector<HTMLElement>('summary')?.focus();
    });
  }

  function closeEditor() {
    setOpen(false);
    setDraft(EMPTY_DRAFT);
    if (editorRef.current) editorRef.current.open = false;
  }

  function startEdit(region: GeoRegion) {
    openEditor({
      id: region.id,
      nameAr: region.nameAr,
      nameEn: region.nameEn,
      description: '',
      kind: region.kind,
      parentId: region.parentId,
      governorateIds: region.governorateIds,
      districtIds: region.districtIds,
    });
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
    if (!active && draft.id === region.id) closeEditor();
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
      closeEditor();
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
    closeEditor();
    setMessage(t('geo.saved'));
  }

  /*
   * The page: the regions as cards, then the two forms as rows you press.
   *
   * The screen used to be a table and a view swap — pressing *Edit* replaced the list with a very tall form, so you
   * lost the thing you were editing while you edited it. Cards keep the tree on screen (a sub-region is indented under
   * its parent), and both forms are native <details>: the list stays where it is and the form opens underneath it.
   */
  const regionCard = (region: GeoRegion, depth: number, retired: boolean) => {
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
        className="geo-region-card"
        data-depth={depth}
        data-retired={retired ? 'true' : undefined}
      >
        <div className="geo-region-card__head">
          <div className="geo-region-card__identity">
            <h3 className="geo-region-card__name">{nameOf(region)}</h3>
            <span className="geo-region-card__kind">
              {region.kind === 'region' ? t('geo.kindRegion') : t('geo.kindSubRegion')}
            </span>
          </div>
          <Badge tone={retired ? 'neutral' : 'success'}>
            {retired ? t('geo.statusRetired') : t('geo.statusActive')}
          </Badge>
        </div>

        {/* Counts, not a sentence with two dots in it: what a region covers is the one thing this card is for. */}
        <ul className="geo-region-card__facts">
          <li>{districtsLabel(districts.length)}</li>
          <li>{governoratesLabel(region.governorateIds.length)}</li>
          {extra.length > 0 ? <li>{extraLabel(extra.length)}</li> : null}
        </ul>

        <div className="geo-region-card__actions">
          {retired ? (
            <Button
              variant="subtle"
              size="sm"
              disabled={busy}
              onClick={() => setActive(region, true)}
            >
              {t('geo.reactivate')}
            </Button>
          ) : (
            <>
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
            </>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="geo-regions-page">
      <section className="console-section geo-regions" aria-labelledby="geo-region-list">
        <div className="console-section__head">
          <h2 id="geo-region-list">{t('geo.treeHeading')}</h2>
          <span className="console-section__meta">{activeRegions.length}</span>
        </div>
        <p className="form-hint">{t('geo.depthWarning')}</p>

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

        {regions.length === 0 ? (
          <EmptyState title={t('geo.noRegions')} description={t('geo.coverageHint')} icon="route" />
        ) : (
          <>
            <ul className="geo-region-grid">
              {treeRows.map((row) => regionCard(row.region, row.depth, false))}
            </ul>

            {retiredRegions.length > 0 ? (
              <div className="geo-retired">
                <h3 className="geo-retired__title">
                  {t('geo.statusRetired')}
                  <span className="console-section__meta">{retiredRegions.length}</span>
                </h3>
                <ul className="geo-region-grid">
                  {retiredRegions.map((region) => regionCard(region, 0, true))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </section>

      <details
        className="panel-disclosure geo-editor"
        id="geo-region-form"
        ref={editorRef}
        suppressHydrationWarning
        onToggle={(event) => {
          // Closing the row by hand is a cancel: the draft does not linger behind a closed panel.
          if (!event.currentTarget.open) closeEditor();
        }}
      >
        <summary className="panel-disclosure__summary">
          <span className="panel-disclosure__icon" aria-hidden="true">
            <Icon name="plus" size={16} />
          </span>
          <span className="panel-disclosure__text">
            <span className="panel-disclosure__title">
              {open && editing ? t('geo.editRegion') : t('geo.newRegion')}
            </span>
            <span className="panel-disclosure__hint">
              {open && editing ? nameOf(editing) : t('geo.newRegionHint')}
            </span>
          </span>
          <span className="panel-disclosure__chevron" aria-hidden="true">
            <DirectionalIcon direction="down" size={16} />
          </span>
        </summary>

        <div className="panel-disclosure__body">
          <div className="geo-editor__grid">
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

              <p className="geo-group__label geo-group__label--sub">
                {t('geo.extraDistricts')}
                <span className="geo-group__count">
                  {translateCount(locale, 'geo.extraChosen', extraDistricts.length)}
                </span>
              </p>
              <p className="form-hint">{t('geo.extraDistrictsHint')}</p>

              <div className="geo-filter">
                <Select
                  label={t('geo.districtFilter')}
                  value={effectiveFilter}
                  onChange={(event) => setDistrictFilter(event.target.value)}
                  options={directory.governorates.map((governorate) => ({
                    value: governorate.id,
                    label: locale === 'ar' ? governorate.nameAr : governorate.nameEn,
                  }))}
                />
              </div>

              <div className="geo-check-grid" aria-label={t('geo.districts')}>
                {filteredDistricts.map((district) => (
                  <label key={district.id} className="geo-check">
                    <input
                      type="checkbox"
                      checked={draft.districtIds.includes(district.id)}
                      onChange={() =>
                        setDraft({
                          ...draft,
                          districtIds: toggle(draft.districtIds, district.id),
                        })
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
          </div>

          <div className="geo-editor__foot">
            <p className="geo-editor__recap" aria-live="polite">
              {districtsLabel(covered.length)}
              {' · '}
              {governoratesLabel(draft.governorateIds.length)}
              {extraDistricts.length > 0 ? ` · ${extraLabel(extraDistricts.length)}` : ''}
            </p>
            <div className="form-actions">
              <Button variant="primary" onClick={save} disabled={busy} loading={busy}>
                {t('common.save')}
              </Button>
              <Button variant="ghost" onClick={closeEditor}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );
}

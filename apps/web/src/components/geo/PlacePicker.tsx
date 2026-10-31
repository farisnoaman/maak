'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  EMPTY_SELECTION,
  PLACE_KIND_KEY,
  isSelectionComplete,
  rankPlaces,
  reducePicker,
  toPlaceSearchResult,
  translate,
  type Locale,
  type PickerSelection,
  type PlaceKind,
  type PlaceRef,
  type TranslationKey,
} from '@maak/core';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import type { GeoDirectory } from '@/lib/geo-types';

/**
 * The one place picker.
 *
 * Behaviour that matters:
 *  · selecting a governorate **browses** its places instead of showing an empty box, and clears the
 *    district and place (`reducePicker`, tested in @maak/core);
 *  · typing searches — `search_places` when a project is configured (server ranking, private places
 *    for their creator), `rankPlaces()` over the loaded reference set otherwise;
 *  · a custom name is a first-class answer, so a driver can name a corner the reference has never
 *    heard of without waiting for a review.
 *
 * Phase 3 (trip creation) consumes this component unchanged for pickup, gathering point and
 * destination.
 */
export function PlacePicker({
  locale,
  directory,
  label,
  value,
  onChange,
}: {
  readonly locale: Locale;
  readonly directory: GeoDirectory;
  readonly label: TranslationKey;
  readonly value?: PickerSelection;
  readonly onChange?: (selection: PickerSelection) => void;
}) {
  const t = (key: TranslationKey) => translate(locale, key);

  const [selection, setSelection] = useState<PickerSelection>(value ?? EMPTY_SELECTION);
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<
    readonly { id: string; name: string; kind: string }[] | null
  >(null);
  const [searching, setSearching] = useState(false);

  const dispatch = (action: Parameters<typeof reducePicker>[1]) => {
    setSelection((current) => {
      const next = reducePicker(current, action);
      onChange?.(next);
      return next;
    });
    // A stale remote result set would otherwise linger after the filters changed.
    setRemote(null);
  };

  const districts = useMemo(
    () =>
      selection.governorateId
        ? directory.districts.filter(
            (district) => district.governorateId === selection.governorateId,
          )
        : [],
    [directory.districts, selection.governorateId],
  );

  const refs = useMemo<PlaceRef[]>(
    () => directory.places.map((place) => ({ ...place, kind: place.kind as PlaceKind })),
    [directory.places],
  );

  // Local ranking is instant and always available. An empty query still ranks (by kind/name) so
  // picking a governorate lists its places — a picker that shows nothing until you type is a dead end.
  const localMatches = useMemo(() => {
    const narrowed = query.trim()
      ? refs
      : refs.filter(
          (place) =>
            (!selection.governorateId || place.governorateId === selection.governorateId) &&
            (!selection.districtId || place.districtId === selection.districtId),
        );
    return rankPlaces(query, narrowed, {
      governorateId: selection.governorateId ?? undefined,
      districtId: selection.districtId ?? undefined,
      limit: 8,
    }).map((place) => ({
      id: place.id,
      name: locale === 'ar' ? place.nameAr : (place.nameEn ?? place.nameAr),
      kind: place.kind,
    }));
  }, [locale, query, refs, selection.districtId, selection.governorateId]);

  useEffect(() => {
    // Search only runs on a real query: an empty query is browsing, which local ranking already does
    // without a round trip.
    if (!directory.configured || query.trim().length === 0) {
      setRemote(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        // Same-origin proxy: the session cookie travels automatically, and the token never reaches
        // this bundle (see app/api/data/[...path]/route.ts).
        const response = await fetch('/api/data/rest/v1/rpc/search_places', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            p_query: query,
            p_locale: locale,
            p_governorate: selection.governorateId ?? null,
            p_district: selection.districtId ?? null,
            p_kind: null,
            p_limit: 8,
          }),
          credentials: 'same-origin',
        });
        if (cancelled) return;
        const data: unknown = response.ok ? await response.json() : [];
        const rows = Array.isArray(data) ? data : [];
        setRemote(
          rows.map((row) => {
            const result = toPlaceSearchResult(row as Record<string, unknown>);
            return { id: result.id, name: result.name, kind: result.kind };
          }),
        );
        setSearching(false);
      })();
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [directory.configured, locale, query, selection.districtId, selection.governorateId]);

  const matches = remote ?? localMatches;
  const chosen = directory.places.find((place) => place.id === selection.placeId);
  const complete = isSelectionComplete(selection);

  return (
    <fieldset className="geo-coverage">
      <legend>{t(label)}</legend>
      <div className="form-grid">
        <Select
          label={t('picker.governorate')}
          value={selection.governorateId ?? ''}
          onChange={(event) => dispatch({ type: 'governorate', id: event.target.value || null })}
          options={[
            { value: '', label: t('picker.allGovernorates') },
            ...directory.governorates.map((governorate) => ({
              value: governorate.id,
              label: locale === 'ar' ? governorate.nameAr : governorate.nameEn,
            })),
          ]}
          hint={t('picker.changeClears')}
        />
        <Select
          label={t('picker.district')}
          value={selection.districtId ?? ''}
          onChange={(event) => dispatch({ type: 'district', id: event.target.value || null })}
          disabled={districts.length === 0}
          options={[
            { value: '', label: t('picker.anyDistrict') },
            ...districts.map((district) => ({
              value: district.id,
              label: locale === 'ar' ? district.nameAr : district.nameEn,
            })),
          ]}
        />
        <Field
          label={t('places.search')}
          value={query}
          placeholder={t('places.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Field
          label={t('places.custom')}
          value={selection.customName ?? ''}
          placeholder={t('picker.customPlaceholder')}
          onChange={(event) => dispatch({ type: 'custom', name: event.target.value })}
        />
      </div>

      {searching ? <p className="form-hint">{t('picker.searching')}</p> : null}

      {matches.length > 0 ? (
        <ul className="geo-result-list" aria-label={t('picker.place')}>
          {matches.map((place) => (
            <li key={place.id}>
              <label className="geo-check">
                <input
                  type="radio"
                  name={`place-${label}`}
                  checked={selection.placeId === place.id}
                  onChange={() => dispatch({ type: 'place', id: place.id })}
                />
                <span>{place.name}</span>
                <span className="form-hint">
                  {t(PLACE_KIND_KEY[place.kind as PlaceKind] as TranslationKey)}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="form-hint">{query.trim() ? t('places.noResults') : t('places.browseHint')}</p>
      )}

      <p className={complete ? 'form-success' : 'form-hint'} aria-live="polite">
        {complete
          ? `${t('picker.place')}: ${
              chosen
                ? locale === 'ar'
                  ? chosen.nameAr
                  : (chosen.nameEn ?? chosen.nameAr)
                : (selection.customName ?? '')
            }`
          : t('picker.required')}
      </p>
    </fieldset>
  );
}

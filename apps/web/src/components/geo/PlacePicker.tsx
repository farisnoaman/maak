'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  EMPTY_SELECTION,
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
import { getBrowserClient } from '@/lib/supabase/browser';
import type { GeoDirectory } from '@/lib/geo-types';

/**
 * The one place picker.
 *
 * State transitions live in `reducePicker()` (@maak/core), so changing the governorate clears the
 * district and the place — the rule is tested there, not re-implemented here. Search goes to
 * `search_places` when a project is configured (server-side ranking, private places included for
 * their creator) and falls back to `rankPlaces()` over the loaded reference set in preview mode.
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
  const [remote, setRemote] = useState<readonly { id: string; name: string }[] | null>(null);
  const [searching, setSearching] = useState(false);

  const dispatch = (action: Parameters<typeof reducePicker>[1]) => {
    setSelection((current) => {
      const next = reducePicker(current, action);
      onChange?.(next);
      return next;
    });
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

  // Local ranking is instant and always available; the RPC adds private places and server ranking.
  const localMatches = useMemo(() => {
    if (!query.trim() && !selection.governorateId) return [];
    const refs: PlaceRef[] = directory.places.map((place) => ({
      ...place,
      kind: place.kind as PlaceKind,
    }));
    return rankPlaces(query, refs, {
      governorateId: selection.governorateId ?? undefined,
      districtId: selection.districtId ?? undefined,
      limit: 8,
    }).map((place) => ({
      id: place.id,
      name: locale === 'ar' ? place.nameAr : (place.nameEn ?? place.nameAr),
    }));
  }, [directory.places, locale, query, selection.districtId, selection.governorateId]);

  useEffect(() => {
    if (!directory.configured) {
      setRemote(null);
      return;
    }
    const supabase = getBrowserClient();
    if (!supabase) return;

    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        const { data } = await supabase.rpc('search_places', {
          p_query: query,
          p_locale: locale,
          p_governorate: selection.governorateId,
          p_district: selection.districtId,
          p_kind: null,
          p_limit: 8,
        });
        if (cancelled) return;
        const rows = Array.isArray(data) ? data : [];
        setRemote(
          rows.map((row) => {
            const result = toPlaceSearchResult(row as Record<string, unknown>);
            return { id: result.id, name: result.name };
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
          label={t('picker.custom')}
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
              </label>
            </li>
          ))}
        </ul>
      ) : null}

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

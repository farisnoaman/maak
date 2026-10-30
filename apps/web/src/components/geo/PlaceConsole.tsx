'use client';

import { useState } from 'react';
import {
  errorKey,
  geoCommandSpec,
  translate,
  type Locale,
  type PlaceKind,
  type TranslationKey,
} from '@maak/core';
import { Badge } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { getApiClient } from '@/lib/api';
import { PlacePicker } from '@/components/geo/PlacePicker';
import type { GeoDirectory, GeoPendingPlace } from '@/lib/geo-types';

const KINDS: readonly PlaceKind[] = [
  'gathering_point',
  'landmark',
  'station',
  'market',
  'city',
  'town',
  'village',
  'hospital',
  'airport',
  'port',
  'border_crossing',
  'other',
];

/**
 * Places console: the review queue, the "add a place" form and a live picker.
 *
 * Deciding a place is staff-only (badge + the command re-checks). Creating one is open to any
 * verified account, but the result starts *private and pending* — which the note under the form says
 * out loud so nobody expects it to appear in search immediately.
 */
export function PlaceConsole({
  locale,
  directory,
  canDecide,
}: {
  readonly locale: Locale;
  readonly directory: GeoDirectory;
  readonly canDecide: boolean;
}) {
  const t = (key: TranslationKey) => translate(locale, key);

  const [queue, setQueue] = useState<readonly GeoPendingPlace[]>(directory.pendingPlaces);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState({
    kind: 'gathering_point' as PlaceKind,
    nameAr: '',
    nameEn: '',
    governorateId: directory.governorates[0]?.id ?? '',
    districtId: '',
  });

  const districts = directory.districts.filter(
    (district) => district.governorateId === draft.governorateId,
  );

  async function decide(place: GeoPendingPlace, outcome: 'approve' | 'reject') {
    const reason = (reasons[place.id] ?? '').trim();
    if (outcome === 'reject' && reason.length < 10) {
      setError(t('places.rejectHint'));
      return;
    }

    if (!directory.configured) {
      setQueue((current) => current.filter((row) => row.id !== place.id));
      setMessage(t('geo.previewNotice'));
      return;
    }

    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }

    setBusy(place.id);
    setError(null);
    const result = await client.call(geoCommandSpec, {
      action: 'place.decide',
      placeId: place.id,
      outcome,
      reason: reason || undefined,
    });
    setBusy(null);

    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setQueue((current) => current.filter((row) => row.id !== place.id));
    setMessage(t('places.decided'));
  }

  async function createPlace() {
    setError(null);
    setMessage(null);

    if (!directory.configured) {
      setDraft((current) => ({ ...current, nameAr: '', nameEn: '' }));
      setMessage(t('geo.previewNotice'));
      return;
    }

    const client = getApiClient();
    if (!client) {
      setError(t('verification.notConfigured'));
      return;
    }

    setBusy('create');
    const result = await client.call(geoCommandSpec, {
      action: 'place.create',
      kind: draft.kind,
      nameAr: draft.nameAr.trim(),
      nameEn: draft.nameEn.trim() || undefined,
      governorateId: draft.governorateId || undefined,
      districtId: draft.districtId || undefined,
      aliasesAr: [],
      aliasesEn: [],
    });
    setBusy(null);

    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setDraft((current) => ({ ...current, nameAr: '', nameEn: '' }));
    setMessage(t('places.created'));
  }

  return (
    <div className="geo-console">
      {canDecide ? (
        <section className="card" aria-labelledby="places-queue">
          <div className="panel-head">
            <h2 id="places-queue">{t('places.queueTitle')}</h2>
            <Badge tone="warning">{queue.length}</Badge>
          </div>

          {queue.length === 0 ? (
            <p className="form-hint">{t('places.queueEmpty')}</p>
          ) : (
            <ul className="queue-list">
              {queue.map((place) => (
                <li key={place.id} className="queue-card">
                  <div>
                    <p style={{ fontWeight: 700, margin: 0 }}>{place.nameAr}</p>
                    <p className="form-hint" style={{ margin: 0 }}>
                      {[place.districtName, place.governorateName].filter(Boolean).join(' · ')}
                      {place.submittedBy
                        ? ` · ${t('places.submittedBy')}: ${place.submittedBy}`
                        : ''}
                    </p>
                    <p className="form-hint" style={{ margin: 0 }}>
                      {place.kind}
                      {place.lat != null && place.lng != null
                        ? ` · ${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`
                        : ''}
                    </p>
                    <Field
                      label={t('places.rejectReason')}
                      hint={t('places.rejectHint')}
                      value={reasons[place.id] ?? ''}
                      onChange={(event) =>
                        setReasons((current) => ({ ...current, [place.id]: event.target.value }))
                      }
                    />
                  </div>
                  <div className="geo-row-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busy === place.id}
                      onClick={() => decide(place, 'approve')}
                    >
                      {t('places.approve')}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy === place.id}
                      onClick={() => decide(place, 'reject')}
                    >
                      {t('places.reject')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="card" aria-labelledby="places-create">
        <div className="panel-head">
          <h2 id="places-create">{t('places.addPlace')}</h2>
          <Badge tone="info">{t('places.pending')}</Badge>
        </div>
        <p className="form-hint">{t('places.gatheringPointNote')}</p>

        <div className="form-grid">
          <Field
            label={t('places.nameAr')}
            required
            value={draft.nameAr}
            onChange={(event) => setDraft({ ...draft, nameAr: event.target.value })}
          />
          <Field
            label={t('places.nameEn')}
            dir="ltr"
            value={draft.nameEn}
            onChange={(event) => setDraft({ ...draft, nameEn: event.target.value })}
          />
          <Select
            label={t('places.kind')}
            value={draft.kind}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value as PlaceKind })}
            options={KINDS.map((kind) => ({ value: kind, label: kind.replace(/_/g, ' ') }))}
          />
          <Select
            label={t('places.governorate')}
            value={draft.governorateId}
            onChange={(event) =>
              setDraft({ ...draft, governorateId: event.target.value, districtId: '' })
            }
            options={directory.governorates.map((governorate) => ({
              value: governorate.id,
              label: locale === 'ar' ? governorate.nameAr : governorate.nameEn,
            }))}
          />
          <Select
            label={t('places.district')}
            value={draft.districtId}
            onChange={(event) => setDraft({ ...draft, districtId: event.target.value })}
            options={[
              { value: '', label: t('picker.anyDistrict') },
              ...districts.map((district) => ({
                value: district.id,
                label: locale === 'ar' ? district.nameAr : district.nameEn,
              })),
            ]}
          />
        </div>

        <div className="form-actions">
          <Button
            variant="primary"
            onClick={createPlace}
            disabled={busy === 'create' || draft.nameAr.trim().length < 3}
            loading={busy === 'create'}
          >
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

      <section className="card" aria-labelledby="places-picker">
        <div className="panel-head">
          <h2 id="places-picker">{t('picker.title')}</h2>
          <Badge tone="info">{t('places.search')}</Badge>
        </div>
        <PlacePicker locale={locale} directory={directory} label="picker.place" />
      </section>
    </div>
  );
}

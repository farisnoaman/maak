'use client';

import { useState } from 'react';
import {
  PLACE_KIND_KEY,
  USER_CREATABLE_KINDS,
  errorKey,
  formatDate,
  geoCommandSpec,
  isWithinYemen,
  translate,
  type Locale,
  type PlaceKind,
  type TranslationKey,
} from '@maak/core';
import { EmptyState } from '@/components/ui/Feedback';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { DirectionalIcon } from '@/components/ui/DirectionalIcon';
import { Select } from '@/components/ui/Select';
import { getApiClient } from '@/lib/api';
import { PlacePicker } from '@/components/geo/PlacePicker';
import type { GeoDirectory, GeoPendingPlace } from '@/lib/geo-types';

/**
 * Places console: the review queue and the "add a place" form, plus a live picker.
 *
 * Only `USER_CREATABLE_KINDS` are offered to ordinary accounts: a verified user drops a pin for the
 * street their trip leaves from, not a new "city". Staff may create reference places (city, station,
 * airport…), which is why the list widens for them — and the command re-checks the same rule.
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
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [queue, setQueue] = useState<readonly GeoPendingPlace[]>(directory.pendingPlaces);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  /* Rejecting asks a question, so it opens; the reason field is not furniture on every queued place. */
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const kinds: readonly PlaceKind[] = canDecide
    ? [
        'city',
        'town',
        'village',
        'district_centre',
        'landmark',
        'station',
        'airport',
        'port',
        'border_crossing',
        'market',
        'hospital',
        'gathering_point',
        'other',
      ]
    : USER_CREATABLE_KINDS;

  const [draft, setDraft] = useState({
    kind: 'gathering_point' as PlaceKind,
    nameAr: '',
    nameEn: '',
    governorateId: directory.governorates[0]?.id ?? '',
    districtId: '',
    lat: '',
    lng: '',
  });

  const districts = directory.districts.filter(
    (district) => district.governorateId === draft.governorateId,
  );

  // Coordinates are optional, but half a coordinate is a mistake, not a partial answer.
  const lat = draft.lat.trim() === '' ? null : Number(draft.lat);
  const lng = draft.lng.trim() === '' ? null : Number(draft.lng);
  const coordsProvided = draft.lat.trim() !== '' || draft.lng.trim() !== '';
  const coordsValid =
    !coordsProvided ||
    (lat !== null &&
      lng !== null &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      (draft.lat.trim() === '') === (draft.lng.trim() === ''));
  const outsideYemen =
    coordsProvided && coordsValid && lat !== null && lng !== null
      ? !isWithinYemen({ lat, lng })
      : false;

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

    if (!coordsValid) {
      setError(`${t('places.latitude')} / ${t('places.longitude')}`);
      return;
    }
    if (outsideYemen) {
      setError(t('places.outsideYemen'));
      return;
    }

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
      lat: lat ?? undefined,
      lng: lng ?? undefined,
      aliasesAr: [],
      aliasesEn: [],
    });
    setBusy(null);

    if (!result.ok) {
      setError(t(errorKey(result.error.code)));
      return;
    }
    setDraft((current) => ({ ...current, nameAr: '', nameEn: '', lat: '', lng: '' }));
    setMessage(t('places.created'));
  }

  const addSummary = (
    <summary className="panel-disclosure__summary">
      <span className="panel-disclosure__icon" aria-hidden="true">
        <Icon name="plus" size={16} />
      </span>
      <span className="panel-disclosure__text">
        <span className="panel-disclosure__title">{t('places.addPlace')}</span>
        <span className="panel-disclosure__hint">{t('places.gatheringPointNote')}</span>
      </span>
      <span className="panel-disclosure__chevron" aria-hidden="true">
        <DirectionalIcon direction="down" size={16} />
      </span>
    </summary>
  );

  /*
   * The form body is written once. It is either the page (an operator adding a gathering point, where there is no queue
   * above it) or a row you press (staff, whose job here is the queue). `open` is never set on <details>: the attribute
   * belongs to the user, and a controlled one is a hydration mismatch waiting for a fast tap.
   */
  const addForm = (
    <>
      <fieldset className="place-group">
        <legend>{t('places.groupIdentity')}</legend>
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
            options={kinds.map((kind) => ({
              value: kind,
              label: t(PLACE_KIND_KEY[kind] as TranslationKey),
            }))}
          />
        </div>
      </fieldset>

      <fieldset className="place-group">
        <legend>{t('places.groupLocation')}</legend>
        <div className="form-grid">
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
          <Field
            label={t('places.latitude')}
            inputMode="decimal"
            dir="ltr"
            value={draft.lat}
            onChange={(event) => setDraft({ ...draft, lat: event.target.value })}
            error={coordsProvided && !coordsValid ? t('places.latitude') : undefined}
          />
          <Field
            label={t('places.longitude')}
            inputMode="decimal"
            dir="ltr"
            value={draft.lng}
            onChange={(event) => setDraft({ ...draft, lng: event.target.value })}
            error={outsideYemen ? t('places.outsideYemen') : undefined}
          />
        </div>
      </fieldset>

      <div className="form-actions">
        <Button
          variant="primary"
          onClick={createPlace}
          disabled={
            busy === 'create' || draft.nameAr.trim().length < 3 || outsideYemen || !coordsValid
          }
          loading={busy === 'create'}
        >
          {t('common.save')}
        </Button>
        <span className="panel-disclosure__note">{t('places.fieldsRequired')}</span>
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
    </>
  );

  return (
    <div className="geo-console">
      {/*
        The queue comes first, because a staff member opening this page is here to decide something. Each submission is
        a card: the name is the heading, the kind is a chip beside it, and the four facts that actually decide a place —
        which governorate, which district, where on the map, who sent it — are labelled rows instead of one run of
        text with `·` between them.
      */}
      {canDecide ? (
        <section className="console-section" aria-labelledby="places-queue">
          <div className="console-section__head">
            <h2 id="places-queue">{t('places.queueTitle')}</h2>
            <span className="console-section__meta">{queue.length}</span>
          </div>

          {queue.length === 0 ? (
            <EmptyState
              title={t('places.queueEmpty')}
              description={t('places.subtitle')}
              icon="check"
            />
          ) : (
            <ul className="place-grid">
              {queue.map((place) => (
                <li key={place.id} className="place-card">
                  <div className="place-card__head">
                    <h3 className="place-card__name">{place.nameAr}</h3>
                    <span className="place-card__kind">
                      {t(PLACE_KIND_KEY[place.kind as PlaceKind] as TranslationKey)}
                    </span>
                  </div>

                  {place.nameEn ? (
                    <p className="place-card__alt" lang="en" dir="ltr">
                      {place.nameEn}
                    </p>
                  ) : null}

                  <dl className="place-card__meta">
                    <div>
                      <dt>{t('places.governorate')}</dt>
                      <dd>{place.governorateName ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>{t('places.district')}</dt>
                      <dd>{place.districtName ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>{t('places.coordinates')}</dt>
                      <dd className="num">
                        {place.lat != null && place.lng != null ? (
                          <bdi dir="ltr">
                            {place.lat.toFixed(4)}, {place.lng.toFixed(4)}
                          </bdi>
                        ) : (
                          '—'
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('places.submittedBy')}</dt>
                      <dd>
                        {place.submittedByName ??
                          (place.submittedBy ? (
                            <bdi dir="ltr" className="id-short">
                              {place.submittedBy.slice(0, 8)}
                            </bdi>
                          ) : (
                            '—'
                          ))}
                      </dd>
                    </div>
                  </dl>

                  {place.createdAt ? (
                    <p className="place-card__when">
                      {t('places.submittedAt', {
                        date: formatDate(place.createdAt, { locale }),
                      })}
                    </p>
                  ) : null}

                  <div className="place-card__actions">
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
                      onClick={() => setRejecting(rejecting === place.id ? null : place.id)}
                    >
                      {t('places.reject')}
                    </Button>
                  </div>

                  {/* Asking why, only once the answer was "no" — sand, because a human is now involved. */}
                  {rejecting === place.id ? (
                    <div className="place-card__reject">
                      <Field
                        label={t('places.rejectReason')}
                        hint={t('places.rejectHint')}
                        value={reasons[place.id] ?? ''}
                        onChange={(event) =>
                          setReasons((current) => ({ ...current, [place.id]: event.target.value }))
                        }
                      />
                      <div className="place-card__reject-actions">
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={
                            busy === place.id || (reasons[place.id] ?? '').trim().length < 10
                          }
                          onClick={() => decide(place, 'reject')}
                        >
                          {t('places.reject')}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setRejecting(null)}>
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/*
        Eleven fields were standing open under the queue on every visit, whether or not anyone was adding a place. The
        form is one row you press — a native <details>, so it opens without JavaScript and never traps the keyboard —
        and on a page with no queue (an operator adding a gathering point) it starts open, because there it is the page.
      */}
      {canDecide ? (
        <details className="panel-disclosure" id="places-create" suppressHydrationWarning>
          {addSummary}
          <div className="panel-disclosure__body">{addForm}</div>
        </details>
      ) : (
        <section className="console-section" aria-labelledby="places-create">
          <div className="console-section__head">
            <h2 id="places-create">{t('places.addPlace')}</h2>
          </div>
          <p className="form-hint">{t('places.gatheringPointNote')}</p>
          {addForm}
        </section>
      )}

      {/* The picker is a tool you reach for, not a section you read: same disclosure, same row. */}
      <details className="panel-disclosure" suppressHydrationWarning>
        <summary className="panel-disclosure__summary">
          <span className="panel-disclosure__icon" aria-hidden="true">
            <Icon name="search" size={16} />
          </span>
          <span className="panel-disclosure__text">
            <span className="panel-disclosure__title">{t('places.findPlace')}</span>
            <span className="panel-disclosure__hint">{t('places.browseHint')}</span>
          </span>
          <span className="panel-disclosure__chevron" aria-hidden="true">
            <DirectionalIcon direction="down" size={16} />
          </span>
        </summary>
        <div className="panel-disclosure__body">
          <PlacePicker locale={locale} directory={directory} label="picker.place" />
        </div>
      </details>
    </div>
  );
}

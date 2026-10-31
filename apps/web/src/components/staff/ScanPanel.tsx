'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { formatDateTime, translate, type Locale, type TranslationKey } from '@maak/core';
import { Button } from '@/components/ui/Button';
import type { ScanResult } from '@/lib/staff-ops';

type DetectorCtor = new (options?: { formats?: string[] }) => {
  detect(source: CanvasImageSource | ImageBitmapSource): Promise<{ rawValue: string }[]>;
};

/**
 * The scanner.
 *
 * Two ways in, one code path: the camera when the browser has `BarcodeDetector` and permission, and a
 * text box always. The manual field is not a fallback for old browsers — a checkpoint tablet in the sun
 * with a cracked screen needs to be able to type 24 hex characters, and a token printed on a manifest is
 * a perfectly good input. So the camera is an accelerator, never the only way.
 *
 * The detection loop is a `setInterval` over a hidden canvas rather than a stream into a library: the
 * native detector is the only one in the bundle, and `BarcodeDetector` is absent on Firefox and Safari —
 * where the page says so plainly instead of showing a black rectangle.
 */
export function ScanPanel({ locale }: { readonly locale: Locale }) {
  const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars);

  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [camera, setCamera] = useState<'off' | 'on' | 'unsupported' | 'denied'>('off');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const scan = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (trimmed === '') return;
    setBusy(true);
    const response = await fetch('/api/staff/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: trimmed }),
    });
    const payload = (await response.json().catch(() => null)) as ScanResult | null;
    setBusy(false);
    if (payload) {
      setResult(payload);
      setToken(trimmed);
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCamera('off');
  }, []);

  const startCamera = useCallback(async () => {
    const Detector = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setCamera('unsupported');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
    } catch {
      setCamera('denied');
      return;
    }
    streamRef.current = stream;
    setCamera('on');

    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    await video.play().catch(() => undefined);

    const detector = new Detector({ formats: ['qr_code'] });
    timerRef.current = setInterval(async () => {
      if (!videoRef.current || videoRef.current.readyState < 2) return;
      try {
        const found = await detector.detect(videoRef.current);
        const value = found[0]?.rawValue;
        if (value) {
          stopCamera();
          await scan(value);
        }
      } catch {
        // A detector that throws on one frame is not an error worth surfacing; the interval retries.
      }
    }, 400);
  }, [scan, stopCamera]);

  useEffect(() => stopCamera, [stopCamera]);

  return (
    <div className="ops-scan">
      <form
        className="card ops-scan__manual"
        onSubmit={(event) => {
          event.preventDefault();
          void scan(token);
        }}
      >
        <label className="ui-field__label" htmlFor="scan-token">
          {t('ops.scanToken')}
        </label>
        <input
          id="scan-token"
          className="ui-input ops-scan__input"
          dir="ltr"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={24}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="000000000000000000000000"
        />
        <p className="form-hint">{t('ops.scanHint')}</p>
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={busy || token.trim() === ''}>
            {t('ops.scanSubmit')}
          </Button>
          {camera === 'on' ? (
            <Button type="button" variant="ghost" onClick={stopCamera}>
              {t('ops.scanCameraOff')}
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={() => void startCamera()}>
              {t('ops.scanCamera')}
            </Button>
          )}
        </div>
        {camera === 'unsupported' ? (
          <p className="ui-alert ui-alert--warning" role="status">
            {t('ops.scanCameraUnsupported')}
          </p>
        ) : null}
        {camera === 'denied' ? (
          <p className="ui-alert ui-alert--warning" role="status">
            {t('ops.scanCameraOff')}
          </p>
        ) : null}
      </form>

      {/* `aria-live` is the whole point: a scan happens without a click, so the answer must announce. */}
      <div aria-live="polite" aria-atomic="true">
        {result && result.allowed ? (
          <section className="card ops-trip">
            <h2>
              {result.trip.code}{' '}
              <span className="form-hint">
                {result.trip.origin} → {result.trip.destination}
              </span>
            </h2>
            <dl className="ops-facts">
              <div>
                <dt>{t('ops.departure')}</dt>
                <dd>{formatDateTime(result.trip.departureAt, { locale })}</dd>
              </div>
              <div>
                <dt>{t('ops.occupancy')}</dt>
                <dd>
                  {t('ops.occupancyValue', {
                    booked: result.trip.bookedSeats,
                    total: result.trip.seatsTotal,
                  })}
                </dd>
              </div>
              <div>
                <dt>{t('ops.operator')}</dt>
                <dd>{result.trip.operatorName ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('ops.driver')}</dt>
                <dd>{result.trip.driverName ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('ops.vehicle')}</dt>
                <dd>{result.trip.vehicleLabel ?? '—'}</dd>
              </div>
            </dl>
            <Link
              className="btn btn--primary"
              href={`/${locale}/staff/trips/${result.trip.id}/manifest`}
            >
              {t('ops.manifest')}
            </Link>
          </section>
        ) : null}

        {result && !result.allowed ? (
          <section className="ui-alert ui-alert--error" role="alert">
            <h2>
              {result.reason === 'OUT_OF_SCOPE'
                ? t('ops.outOfScope')
                : result.reason === 'RATE_LIMITED'
                  ? t('ops.rateLimited')
                  : t('ops.notFound')}
            </h2>
            <p>
              {result.reason === 'OUT_OF_SCOPE'
                ? t('ops.outOfScopeBody')
                : result.reason === 'RATE_LIMITED'
                  ? t('ops.rateLimitedBody' as TranslationKey)
                  : t('ops.notFoundBody')}
            </p>
            {result.route ? (
              <p dir="auto">
                <bdi>{result.route.code}</bdi> · {result.route.origin} → {result.route.destination}
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

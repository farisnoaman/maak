import { NextResponse } from 'next/server';
import { isLocale } from '@maak/core';
import { loadManifest, manifestCsv, manifestFilename } from '@/lib/staff-ops';

/**
 * The manifest as a file.
 *
 * The export is generated from the *same* audited read the page uses, so downloading it is a second
 * `trip.manifest` event in the audit trail — an operator who exports 200 manifests leaves 200 traces.
 * Scope is enforced by `staff_manifest`; this route only decides the content type.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; locale?: string }> },
) {
  const { id } = await params;
  const localeParam = new URL(request.url).searchParams.get('locale') ?? 'ar';
  const locale = isLocale(localeParam) ? localeParam : 'ar';

  const loaded = await loadManifest(id);
  if (!loaded.ok) {
    // 403 for "you may not" (the manifest exists and is not yours), 404 for "there is no such trip".
    return NextResponse.json(
      { error: loaded.reason },
      { status: loaded.reason === 'FORBIDDEN' ? 403 : 404 },
    );
  }

  const { manifest } = loaded;
  return new NextResponse(manifestCsv(manifest.passengers, locale), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${manifestFilename(manifest.trip.code, locale)}"`,
      'cache-control': 'no-store',
    },
  });
}

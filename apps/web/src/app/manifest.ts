import type { MetadataRoute } from 'next';

/**
 * The web app manifest, so a phone can install Maak instead of bookmarking it.
 *
 * `start_url` points at the Arabic marketplace, not at `/`: the market is Yemen, Arabic is the default
 * locale, and an installed app should open on the thing it is for. A visitor who prefers English lands on
 * `/en` from the in-app language switcher, and the choice is remembered by the URL they install from —
 * `start_url` is deliberately not locale-dynamic, because a manifest is one file for one origin.
 *
 * Icons are generated (`/icons/[size]`), not checked in as binaries: one `ImageResponse` keeps the mark in
 * step with the design tokens, and there is no 512px PNG to forget to regenerate.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'معك — منصة الرحلات | Maak',
    short_name: 'معك',
    description: 'ابحث عن رحلة بين المحافظات، أو أدر مركباتك وسائقيك ورحلاتك من مكان واحد.',
    lang: 'ar',
    dir: 'rtl',
    start_url: '/ar/trips',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#0b7f60',
    categories: ['travel', 'business'],
    icons: [
      { src: '/icons/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/512?maskable=1', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'ابحث عن رحلة', short_name: 'الرحلات', url: '/ar/trips' },
      { name: 'رحلاتي', short_name: 'رحلاتي', url: '/ar/account/trips' },
    ],
  };
}

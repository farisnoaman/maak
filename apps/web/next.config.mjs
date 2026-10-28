/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === 'production';

/**
 * Hosts allowed to reach the dev server cross-origin (asset/HMR requests from the hosted preview).
 * Only honoured by `next dev`; production builds ignore it entirely.
 */
const devOrigins = ['*.e2b.app', '*.arena.ai'];

const nextConfig = {
  reactStrictMode: true,
  // Compile the shared TypeScript package instead of relying on a prebuilt artefact.
  transpilePackages: ['@maak/core', '@maak/design-tokens'],
  poweredByHeader: false,
  allowedDevOrigins: devOrigins,
  // Security headers that cost nothing at this stage and prevent whole classes of bugs later.
  async headers() {
    /**
     * Clickjacking defence.
     *
     * Production is locked down with `X-Frame-Options: DENY` plus CSP `frame-ancestors 'none'`.
     * The hosted preview embeds the app in an iframe from another origin, so in every non-production
     * build we swap in a narrow allow-list instead of disabling the protection: `frame-ancestors`
     * (which supersedes `X-Frame-Options` in modern browsers) permits only the preview hosts.
     */
    const antiFraming = isProd
      ? [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ]
      : [
          {
            key: 'Content-Security-Policy',
            value:
              "frame-ancestors 'self' https://*.e2b.app https://*.arena.ai http://localhost:* http://127.0.0.1:*",
          },
        ];

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          ...antiFraming,
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(self), microphone=()' },
        ],
      },
    ];
  },
};

export default nextConfig;

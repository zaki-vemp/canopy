import type { NextConfig } from 'next';

// CANOPY_STATIC=1 writes plain files to out/ for a static host (see firebase.json).
const isStatic = process.env.CANOPY_STATIC === '1';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(isStatic
    ? { output: 'export' as const }
    : {
        async rewrites() {
          const apiBase = process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:8090';
          return [
            // The landing page is one static file, so the gate checks exactly what ships.
            { source: '/', destination: '/landing.html' },
            {
              source: '/api/:path*',
              destination: `${apiBase}/api/:path*`,
            },
          ];
        },
      }),
};

export default nextConfig;

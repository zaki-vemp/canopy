import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
};

export default nextConfig;

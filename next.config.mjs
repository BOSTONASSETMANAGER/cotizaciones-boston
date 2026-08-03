/** @type {import('next').NextConfig} */

// Rewrites portados 1:1 de vercel.json del proyecto Angular. Son los proxies
// same-origin que evitan CORS contra los feeds públicos; los paths que ve el
// cliente NO cambian, así que market.config.ts y el resto de la app siguen
// pidiendo /api/data912/... , /api/yahoo/... , etc. tal cual.
//
// El catch-all de vercel.json ( /(.*) -> /index.html ) NO se porta: era el
// fallback de SPA de Angular; en Next lo resuelve el App Router.
const nextConfig = {
  // Turbopack infería mal la raíz del workspace: detecta el package-lock.json de
  // C:\Users\gh0t y lo elige como root. Lo fijamos al directorio del proyecto
  // para que resuelva los módulos desde acá y no desde el home del usuario.
  turbopack: {
    root: import.meta.dirname,
  },

  async rewrites() {
    return [
      { source: '/api/data912/:path*', destination: 'https://data912.com/:path*' },
      { source: '/api/dolar/:path*', destination: 'https://dolarapi.com/:path*' },
      { source: '/api/bcra/:path*', destination: 'https://api.bcra.gob.ar/:path*' },
      { source: '/api/argentinadatos/:path*', destination: 'https://api.argentinadatos.com/:path*' },
      { source: '/api/yahoo/:path*', destination: 'https://query1.finance.yahoo.com/:path*' },
    ];
  },
};

export default nextConfig;

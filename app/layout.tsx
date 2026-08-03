import type { Metadata, Viewport } from 'next';
import './globals.css';

// Portado de src/index.html: mismo <title>, mismo viewport, mismas fuentes
// (Geist / Geist Mono / Manrope) y mismo favicon. Next inyecta los <link> de
// preconnect + la hoja de Google Fonts desde el <head> de este layout.
export const metadata: Metadata = {
  title: 'Cotizaciones',
  icons: { icon: '/favicon.ico' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&family=Manrope:wght@500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

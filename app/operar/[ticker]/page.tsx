import { Suspense } from 'react';

import Operar from '@/components/Operar';

// Ruta /operar/:ticker — ex `{ path: 'operar/:ticker', component:
// OperarComponent }` de src/app/app.routes.ts. Un solo componente atiende Home
// y la pantalla de orden (gráfico + Puntas + formulario de Orden, ver
// Operar.tsx): el :ticker de la URL hidrata directo esa pantalla — en Angular
// vía withComponentInputBinding (app.config.ts), acá pasándolo como prop —
// sin vistas intermedias, sin servicio de navegación propio.
// ?tipo=venta (opcional) abre el formulario en modo venta en vez de compra
// (ver Cartera → venderDesdeCartera); lo lee Operar.tsx con useSearchParams(),
// de ahí el <Suspense>.
//
// En Next 16 `params` es una Promise y hay que await-earla.
export default async function Page({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  return (
    <Suspense fallback={null}>
      <Operar ticker={ticker} />
    </Suspense>
  );
}

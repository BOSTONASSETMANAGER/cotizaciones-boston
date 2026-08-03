import { Suspense } from 'react';

import Operar from '@/components/Operar';

// Ruta /operar — ex `{ path: 'operar', component: OperarComponent }` de
// src/app/app.routes.ts. Server component fino: sólo monta el componente
// cliente (Operar lleva "use client"). Sin ticker => vista Home de Operar.
//
// Operar está OCULTO del nav (botón removido del shell): la raíz NO redirige
// a /operar — la app arranca en Arbitraje. /operar y /operar/{ticker} siguen
// vivas como entrada manual/deep-link para probar la pantalla.
//
// <Suspense> porque Operar lee los query params ?tipo/?origin con
// useSearchParams(): sin el boundary, Next no puede prerenderizar la ruta.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <Operar />
    </Suspense>
  );
}

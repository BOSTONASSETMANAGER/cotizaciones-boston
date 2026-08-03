import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Los tests del motor de arbitraje son puros; los de storage/snapshot
    // necesitan localStorage, así que jsdom es el entorno por defecto (igual
    // que en el setup de vitest del proyecto Angular).
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts'],
  },
  resolve: {
    alias: {
      '@': new URL('./', import.meta.url).pathname,
    },
  },
});

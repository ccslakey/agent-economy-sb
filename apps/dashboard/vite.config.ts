import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dev server proxies admin calls to the API so the browser needs no CORS setup.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/admin': process.env.API_URL ?? 'http://localhost:3000' } },
});

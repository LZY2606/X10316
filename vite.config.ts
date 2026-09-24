import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { apiPlugin } from './src/server/api';

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: { strictPort: true },
});

/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// base: `vite preview`（command==='build'だがmode==='production'ではない）でも本番同様に
// '/hanatoma/'を使わせるため、command ではなく mode（development/production）で分岐する
// （shadotoma と同じ理由: preview でも GitHub Pages と同じ base で配信しアセット404を防ぐ）。
export default defineConfig(({ mode }) => ({
  base: mode === 'development' ? '/' : '/hanatoma/',
  server: {
    // shadotoma の dev サーバ(5173)と同時起動できるようにポートをずらす。
    port: 5174,
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'pwa-192.png', 'pwa-512.png'],
      manifest: {
        name: 'はなとま',
        short_name: 'はなとま',
        description: 'AI英会話練習アプリ',
        lang: 'ja',
        start_url: '.',
        display: 'standalone',
        background_color: '#fff8f1',
        theme_color: '#ea7317',
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
          },
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
          {
            src: 'pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'apple-touch-icon.png',
            sizes: '180x180',
            type: 'image/png',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,json}'],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
}));

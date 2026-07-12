// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
  site: 'https://thinkmodeplus.com',
  output: 'server',
  adapter: vercel(),
  devToolbar: {
    enabled: false,
  },
  integrations: [sitemap({
    filter: (page) => !page.includes('/auth') && !page.includes('/dashboard'),
  })]
});

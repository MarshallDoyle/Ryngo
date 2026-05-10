// Tailwind v4 is configured primarily via CSS (`@import "tailwindcss"` plus
// `@theme` blocks in src/index.css). This file exists for tooling that still
// expects a config (IDE plugins, prettier-plugin-tailwindcss) and to keep the
// content globs explicit.
import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;

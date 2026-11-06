// web-ext settings: keep the website and branding images out of `web-ext run` and `web-ext build`.
export default {
  ignoreFiles: ['site/**', 'branding/**', 'dist/**', 'node_modules/**'],
};

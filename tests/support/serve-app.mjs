import { build, preview } from "vite";
// Build the production PWA into a test-only directory, using the SQL adapter's URL.
await build({ build: { outDir: ".test-data/site", emptyOutDir: true } });
await preview({
  build: { outDir: ".test-data/site" },
  preview: { host: "127.0.0.1", port: 5173, strictPort: true },
});

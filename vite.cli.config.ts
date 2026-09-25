import { defineConfig } from "vite";

// Bundles cascade-cli (and its MCP server) into one self-contained Node script.
export default defineConfig({
  build: {
    ssr: "src/headless/cli.ts",
    outDir: "dist-cli",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: "cascade-cli.mjs",
        inlineDynamicImports: true,
        banner: "#!/usr/bin/env node",
      },
    },
  },
  ssr: { noExternal: true, target: "node" },
});

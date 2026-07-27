import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "main.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: (asset) => asset.name?.endsWith(".css") ? "style.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
});

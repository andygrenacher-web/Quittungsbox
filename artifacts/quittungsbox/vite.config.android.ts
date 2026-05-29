// Vite build config for the Capacitor/Android APK.
// Does NOT require PORT or BASE_PATH env vars.
// Output: dist/  (Capacitor copies dist/ → android/app/src/main/assets/public/)
import { defineConfig } from "vite";
import react          from "@vitejs/plugin-react";
import tailwindcss    from "@tailwindcss/vite";
import path           from "path";

export default defineConfig({
  base: "./",   // relative paths so file:// protocol works inside WebView

  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },

  root:  path.resolve(import.meta.dirname),
  build: {
    outDir:    path.resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Keep chunks reasonably sized for WebView loading
        manualChunks: {
          react:   ["react", "react-dom"],
          jspdf:   ["jspdf"],
          tesseract: ["tesseract.js"],
        },
      },
    },
  },
});

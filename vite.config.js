import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/gerrit": {
        target: "https://chromium-review.googlesource.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gerrit/, ""),
      },
      "/gitiles": {
        target: "https://chromium.googlesource.com/chromium/src",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/gitiles/, ""),
      },
    },
  },
});

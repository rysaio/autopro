import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5317,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:4317"
    }
  }
});

import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
	// loadEnv is required to read .env.production in vite.config.ts —
	// process.env does not include mode-specific env files at config-load time.
	const env = loadEnv(mode, process.cwd(), "");
	return {
		plugins: [react()],
		// .env.production sets VITE_BASE_PATH=/dashboard/ for the Caddy reverse proxy.
		base: env.VITE_BASE_PATH ?? "/",
		resolve: {
			alias: {
				"@": path.resolve(__dirname, "./src"),
			},
		},
		server: {
			port: 5173,
			proxy: {
				"/api": {
					target: "http://localhost:3457",
					changeOrigin: true,
				},
			},
		},
	};
});

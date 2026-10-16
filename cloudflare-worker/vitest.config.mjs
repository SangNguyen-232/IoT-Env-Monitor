import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.js",
      remoteBindings: false,
      miniflare: {
        compatibilityDate: "2026-10-14",
        serviceBindings: { IOT_BACKEND: "test-backend" },
        workers: [{
          name: "test-backend",
          modules: true,
          compatibilityDate: "2026-10-14",
          script: `export default {
            async fetch(request) {
              if (new URL(request.url).pathname === "/") {
                return new Response(null, { status: 302, headers: { location: "/login" } });
              }
              return Response.json({
                url: request.url,
                method: request.method,
                proto: request.headers.get("x-forwarded-proto"),
                host: request.headers.get("x-forwarded-host"),
                forwardedFor: request.headers.get("x-forwarded-for"),
                body: await request.text(),
              });
            }
          }`,
        }],
      },
    }),
  ],
});

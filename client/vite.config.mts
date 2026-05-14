import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const apiPort = process.env.API_PORT || "9777";
const apiTarget = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [
        "assets/null-vector-thumbnail.svg",
        "assets/null-vector-thumbnail.png",
        "assets/background.jpg",
        "assets/asteroid1.svg",
        "assets/asteroid1.png",
        "assets/asteroid2.svg",
        "assets/asteroid2.png",
        "assets/asteroid3.svg",
        "assets/asteroid3.png",
        "assets/heart.svg",
        "assets/heart.png",
        "assets/bullets.svg",
        "assets/bullets.png",
        "favicon.ico",
        "favicon.png",
        "favicon-16.png",
        "favicon-32.png",
        "favicon.svg",
        "apple-touch-icon.png",
        "assets/favicon.ico",
        "assets/favicon.png",
        "assets/favicon-16.png",
        "assets/favicon-32.png",
        "assets/favicon.svg",
        "assets/apple-touch-icon.png",
      ],
      manifest: {
        name: "Asteroids",
        short_name: "Asteroids",
        description:
          "A fast arcade asteroid-shooter with singleplayer race courses and multiplayer battles.",
        start_url: "/",
        display: "fullscreen",
        orientation: "landscape",
        background_color: "#010611",
        theme_color: "#060f1f",
        icons: [
          {
            src: "/favicon.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "/assets/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "/assets/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "/favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        // Don't precache the large background image; lazy-load via runtime caching.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        globIgnores: ["**/background*.jpg"],
        navigateFallback: "/index.html",
        // Never serve a cached HTML for API or websocket routes.
        navigateFallbackDenylist: [/^\/trpc/, /^\/socket\.io/],
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.destination === "image",
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "asteroids-images",
              expiration: {
                maxEntries: 60,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/socket.io": { target: apiTarget, ws: true },
      "/trpc": apiTarget,
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
});

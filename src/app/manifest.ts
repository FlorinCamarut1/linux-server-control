import type { MetadataRoute } from "next";

// Lets the dashboard be added to a phone's home screen, or installed on a
// computer, as an app of its own: its icon, and a window without the browser's
// bars. Phones open it at the dashboard's address; installing it on Android
// or a computer needs HTTPS.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Linux Server Control",
    short_name: "Server Control",
    description: "Containers, scripts, schedules, files and power of your Linux server.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#090c10",
    theme_color: "#090c10",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

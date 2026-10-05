import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The manifest (manifest.ts) and the apple-icon file make it an installable app.
// On a phone's home screen it fills the screen under a translucent status bar,
// which the page keeps clear of with the safe-area insets. The icons are the
// icon, apple-icon and favicon files next to this one; setting icons here too
// would replace them.
export const metadata: Metadata = {
  title: "Linux Server Control",
  description: "Local dashboard for containers, scripts, and scheduled jobs",
  applicationName: "Linux Server Control",
  appleWebApp: { title: "Server Control", statusBarStyle: "black-translucent" },
};

// Pinch zoom stays allowed. Phones zoom in on a focused field whose text is
// under 16px, which globals.css prevents by giving every field 16px on touch
// screens.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#090c10",
  colorScheme: "dark",
};

const THEME_BOOTSTRAP = `try{var t=localStorage.getItem("lsc-theme")||"dark";if(t!=="system")document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Applies the saved theme before the first paint, so the page never
            flashes in the wrong colors. Mirrors applyTheme in the theme module. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

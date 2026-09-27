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

export const metadata: Metadata = {
  title: "Linux Server Control",
  description: "Local dashboard for containers, scripts, and scheduled jobs",
  icons: { icon: "/icon.svg" },
};

// maximum-scale stops phones from zooming in when a form field is focused and
// staying zoomed afterwards. iOS still allows zooming by pinching.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
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

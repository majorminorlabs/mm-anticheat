import type { Metadata } from "next";
import { Ibarra_Real_Nova, Public_Sans } from "next/font/google";
import { Analytics } from "@/components/analytics";
import { MotionController } from "@/components/motion-controller";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { SiteStructuredData } from "@/components/structured-data";
import { images } from "@/content/site";
import { verificationConfig } from "@/lib/business-profile";
import "./globals.css";

const ibarra = Ibarra_Real_Nova({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
});

const publicSans = Public_Sans({
  variable: "--font-body",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.mobilebayhomewatch.com"),
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/icon.png", type: "image/png", sizes: "600x600" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
  title: {
    default: "Mobile Bay Home Watch | Property Checks for Absentee Owners",
    template: "%s | Mobile Bay Home Watch",
  },
  description:
    "Scheduled property checks for absentee homeowners, seasonal residents, and waterfront property owners around Mobile Bay.",
  openGraph: {
    type: "website",
    siteName: "Mobile Bay Home Watch",
    locale: "en_US",
    url: "https://www.mobilebayhomewatch.com",
    images: [{ url: images.heroHome.src, alt: images.heroHome.alt }],
  },
  twitter: {
    card: "summary_large_image",
  },
  verification:
    verificationConfig.google || verificationConfig.bing
      ? {
          ...(verificationConfig.google ? { google: verificationConfig.google } : {}),
          ...(verificationConfig.bing
            ? { other: { "msvalidate.01": verificationConfig.bing } }
            : {}),
        }
      : undefined,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: the inline script below adds the `js` class
    // to <html> before hydration, which React would otherwise flag.
    <html
      lang="en"
      className={`${ibarra.variable} ${publicSans.variable}`}
      suppressHydrationWarning
    >
      <body>
        <script
          // Gates the [data-reveal] hidden state so content stays visible
          // when JavaScript is unavailable.
          dangerouslySetInnerHTML={{
            __html: "document.documentElement.classList.add('js')",
          }}
        />
        <SiteStructuredData />
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <Analytics />
        <SiteHeader />
        <MotionController />
        <main id="main-content">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}

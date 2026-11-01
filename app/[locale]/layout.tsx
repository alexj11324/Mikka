import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Script from 'next/script';
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";

import { PostHogAnalytics } from "@/components/posthog-analytics";
import { SWRDefaults } from "@/components/swr-defaults";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { routing } from "@/i18n/routing";
import { posthogConfig } from "@/lib/posthog-config";

import "../globals.css";

// Type as Comma sets it: Inter for text, Geist Mono for code, no metric fallback, held until loaded.
// Neither font has Chinese, so Chinese falls through --font-sans to the system font (PingFang on a Mac).
const fontSans = localFont({ src: [{ path: '../fonts/InterVariable.woff2', style: 'normal' }, { path: '../fonts/InterVariable-Italic.woff2', style: 'italic' }], variable: '--font-inter', weight: '100 900', display: 'block', adjustFontFallback: false });
const fontMono = localFont({ src: '../fonts/GeistMono-Variable.woff2', variable: '--font-geist-mono', weight: '100 900', display: 'block', adjustFontFallback: false });

type LocaleParams = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale, namespace: 'Metadata' });
  return {
    title: t('title'),
    description: t('description'),
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#ffffff' }, { media: '(prefers-color-scheme: dark)', color: '#171717' }],
};

export default async function RootLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning className={`${fontSans.variable} ${fontMono.variable}`}>
      <head>
        {/* OpenUI 1.0.1 has no public opt-out; claim its bootstrap guard before imports run. */}
        {process.env.NODE_ENV === 'development' && <Script id="disable-openui-devtools" strategy="beforeInteractive">{'globalThis[Symbol.for("openui.devtools.autoMount")] = true;'}</Script>}
      </head>
      <body className="antialiased in-data-desktop-translucent:bg-transparent">
        <NextIntlClientProvider messages={messages}>
          <ThemeProvider>{posthogConfig.token && <PostHogAnalytics />}<SWRDefaults>{children}</SWRDefaults><Toaster /></ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

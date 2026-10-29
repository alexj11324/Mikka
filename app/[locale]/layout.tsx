import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Script from 'next/script';
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";

import { PostHogAnalytics } from "@/components/posthog-analytics";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { routing } from "@/i18n/routing";
import { posthogConfig } from "@/lib/posthog-config";

import "../globals.css";

const fontSans = localFont({ src: '../fonts/Geist-Variable.woff2', variable: '--font-geist', weight: '100 900' });

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
    <html lang={locale} suppressHydrationWarning className={fontSans.variable}>
      <head>
        {/* OpenUI 1.0.1 has no public opt-out; claim its bootstrap guard before imports run. */}
        {process.env.NODE_ENV === 'development' && <Script id="disable-openui-devtools" strategy="beforeInteractive">{'globalThis[Symbol.for("openui.devtools.autoMount")] = true;'}</Script>}
      </head>
      <body className="antialiased">
        <NextIntlClientProvider messages={messages}>
          <ThemeProvider>{posthogConfig.token && <PostHogAnalytics />}{children}<Toaster /></ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

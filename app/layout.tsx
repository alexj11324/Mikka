import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

const fontSans = Geist({ subsets: ['latin'], variable: '--font-geist' });

export const metadata: Metadata = {
  title: "Orvilo3 · 任务与文档工作台",
  description: "使用列表与拖拽看板管理任务，协作编辑描述、讨论进展并追溯版本。",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#ffffff' }, { media: '(prefers-color-scheme: dark)', color: '#171717' }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className={fontSans.variable}>
      <body
        className="antialiased"
      >
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}

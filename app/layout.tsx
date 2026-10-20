import type { Metadata } from "next";
import { Inter, Noto_Sans_SC } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

const fontSans = Inter({ subsets: ['latin'], variable: '--font-inter' });
const fontChinese = Noto_Sans_SC({ subsets: ['latin'], variable: '--font-noto-sc', display: 'swap' });


export const metadata: Metadata = {
  title: "Orvilo2 · 任务与文档工作台",
  description: "安全管理任务、编辑结构化文档，保存并查看每一次文档版本。",
  robots: { index: false, follow: false }, 
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className={`${fontSans.variable} ${fontChinese.variable}`}>
      <body
        className="antialiased"
      >
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}

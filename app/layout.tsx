import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "成长回路 · 说给 AI，今天就有下一步",
  description: "一个用对话记录学习、安排行动，并在晚间回顾成长的 AI 伴侣。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

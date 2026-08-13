import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TAX ID Checker | ATTECH",
  description: "Tra cứu tình trạng hoạt động mã số thuế nội bộ ATTECH.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}

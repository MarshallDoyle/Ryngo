import type { ReactNode } from "react";

export const metadata = {
  title: "payments-demo",
  description: "codegraph demo fixture",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <a href="/">payments-demo</a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}

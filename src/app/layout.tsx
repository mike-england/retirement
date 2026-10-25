import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "Retirement Planner",
  description: "Canadian retirement planning dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-CA">
      <body>
        {children}
        <Script
          src="https://gc.zgo.at/count.js"
          strategy="afterInteractive"
          data-goatcounter="https://retirement-planner.goatcounter.com/count"
          data-goatcounter-settings={JSON.stringify({ path: "/retirement/", title: "Retirement Planner", referrer: "", no_events: true })}
        />
      </body>
    </html>
  );
}
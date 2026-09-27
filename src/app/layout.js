import "./globals.css";

export const metadata = {
  title: "PhyMamba-XGB | Burn-in Analytics",
  description: "Component and lot-level burn-in screening dashboard with temporal, physics-informed, and population-aware analysis.",
  icons: { icon: "/phymamba-icon.svg" },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}

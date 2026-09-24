import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // exceljs è una libreria Node con dipendenze binarie: lasciarla fuori dal
  // bundle evita che Turbopack provi a risolverne i moduli nativi.
  serverExternalPackages: ["exceljs"],
};

export default nextConfig;

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OncoData Extract | Extracción Clínica para Investigación Oncológica",
  description:
    "Plataforma privada con IA auditable para estructurar historias clínicas oncológicas en bases de datos listas para publicación científica.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}

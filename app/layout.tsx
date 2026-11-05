import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fruit Defect Detection Engine by CIRA CORE',
  description: 'Agritech computer vision control dashboard',
  icons: {
    icon: '/images/cira-core-logo.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}

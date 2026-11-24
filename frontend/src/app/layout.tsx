import type { Metadata, Viewport } from 'next';
import { AppProviders } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Canopy',
  description:
    'Group chat with 24 strangers and one hobby. Everyone in the room is a colour and an animal, including you.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  themeColor: '#f4f4f4',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Gabarito:wght@400..700&family=Figtree:ital,wght@0,400..600;1,400&family=DM+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}

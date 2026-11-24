import type { ReactNode } from 'react';
import { Logo } from '@/components/pieces/Piece';
import ui from '@/components/pieces/ui.module.css';
import s from '@/app/auth.module.css';

// The landing page is a static file, so links to it are plain <a>.
export function Door({ action, children }: { action?: ReactNode; children: ReactNode }) {
  return (
    <div className={s.page}>
      <header className={s.bar}>
        <a href="/" className={s.home} aria-label="Canopy home">
          <Logo />
        </a>
        <nav aria-label="Account">{action}</nav>
      </header>
      {children}
    </div>
  );
}

export function Legal({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <Door
      action={
        <a className={`${ui.btn} ${ui.small} ${ui.blue}`} href="/app">
          Open Canopy
        </a>
      }
    >
      <main className={s.docSheet}>
        <article className={s.doc}>
          <h1>{title}</h1>
          <p className={s.lead}>{lead}</p>
          {children}
        </article>
      </main>
    </Door>
  );
}

import React from 'react';
import Link from 'next/link';
import styles from '../auth.module.css';

export default function TermsPage() {
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <Link href="/" className={styles.brand}>
            <svg
              className={styles.brandMark}
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="#a1ffcb"
            >
              <circle cx="6.5" cy="6.5" r="4.5" stroke="#232323" strokeWidth="1.2" />
              <circle cx="17.5" cy="6.5" r="4.5" stroke="#232323" strokeWidth="1.2" />
              <circle cx="6.5" cy="17.5" r="4.5" stroke="#232323" strokeWidth="1.2" />
              <rect x="13" y="13" width="9" height="9" rx="1.5" stroke="#232323" strokeWidth="1.2" />
            </svg>
            Canopy
          </Link>
          <div className={styles.topActions}>
            <Link href="/" className={styles.ghostLink}>
              Home
            </Link>
            <Link href="/app" className={styles.ghostLink}>
              Open the dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <article className={styles.legalDoc}>
          <h1 className={styles.title}>Terms of service</h1>
          <p className={styles.lead}>
            Ground rules for six-person interest-matched text and voice rooms on Canopy.
          </p>

          <section className={styles.legalSection}>
            <h2 className={styles.legalHeading}>1. Verified accounts</h2>
            <p className={styles.legalText}>
              You must provide accurate account verification details when registering and keep your login credentials confidential. Automated bots, scraping, and duplicate spam accounts are prohibited.
            </p>
          </section>

          <section className={styles.legalSection}>
            <h2 className={styles.legalHeading}>2. Room conduct and anonymity</h2>
            <p className={styles.legalText}>
              Harassment, hate speech, threats, unlawful uploads, and doxxing are strictly banned in all text channels, threads, polls, and WebRTC voice lounges. Respect the blind-room boundary and never pressure peers to reveal personal identity information.
            </p>
          </section>

          <section className={styles.legalSection}>
            <h2 className={styles.legalHeading}>3. Leaving rooms and enforcement</h2>
            <p className={styles.legalText}>
              You may leave or rematch out of any pod in one click at any time. Canopy may suspend accounts that abuse peers or service infrastructure.
            </p>
          </section>
        </article>
      </main>
    </div>
  );
}

import React from 'react';
import Link from 'next/link';
import styles from '../auth.module.css';

export default function PrivacyPage() {
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
          <h1 className={styles.title}>Privacy policy</h1>
          <p className={styles.lead}>
            Canopy verifies accounts privately while keeping every six-person interest room blind to your real identity.
          </p>

          <section className={styles.legalSection}>
            <h2 className={styles.legalHeading}>1. Private account verification</h2>
            <p className={styles.legalText}>
              At registration, Canopy stores your full name, email address, BCrypt password hash, gender, and two-letter nationality code in a private authentication record. Those fields are only returned to your own authenticated session via <code>/api/auth/me</code>.
            </p>
          </section>

          <section className={styles.legalSection}>
            <h2 className={styles.legalHeading}>2. Peer-blind rooms and aliases</h2>
            <p className={styles.legalText}>
              Pod matching queries never inspect gender or nationality. Each time you join an interest pod, Canopy assigns a unique animal alias such as Cobalt Fox and a deterministic room-scoped peer hash. No channel message, thread reply, reaction, poll vote, or WebRTC voice frame ever carries your name, email, gender, nationality, or account ID.
            </p>
          </section>

          <section className={styles.legalSection}>
            <h2 className={styles.legalHeading}>3. Leaving pods and opt-outs</h2>
            <p className={styles.legalText}>
              When you leave a room, Canopy removes your membership immediately and records a pod opt-out so future matches place you into a different group.
            </p>
          </section>
        </article>
      </main>
    </div>
  );
}

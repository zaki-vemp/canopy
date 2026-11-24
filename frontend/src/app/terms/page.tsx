import type { Metadata } from 'next';
import { Legal } from '@/components/door/Door';

export const metadata: Metadata = { title: 'Terms of service, Canopy' };

export default function TermsPage() {
  return (
    <Legal title="Terms of service" lead="Ground rules for the rooms, chats and calls on Canopy.">
      <h2>Verified accounts</h2>
      <p>
        You must provide accurate account verification details when registering and keep your login
        credentials confidential. Automated bots, scraping, and duplicate spam accounts are
        prohibited.
      </p>
      <h2>Room conduct and anonymity</h2>
      <p>
        Harassment, hate speech, threats, unlawful uploads, and doxxing are strictly banned in group
        chats, private chats, polls, votes, and voice calls. Respect the blind-room boundary and
        never pressure anyone to reveal who they are.
      </p>
      <h2>Leaving rooms and enforcement</h2>
      <p>
        You may leave a room, or swap it for another, at any time. Canopy may suspend accounts that
        abuse other people or the service.
      </p>
    </Legal>
  );
}

import type { Metadata } from 'next';
import { Legal } from '@/components/door/Door';

export const metadata: Metadata = { title: 'Privacy policy, Canopy' };

export default function PrivacyPage() {
  return (
    <Legal
      title="Privacy policy"
      lead="Canopy verifies accounts privately and keeps every room blind to who you are."
    >
      <h2>Private account verification</h2>
      <p>
        At registration, Canopy stores your full name, email address, BCrypt password hash, gender,
        and two-letter nationality code in a private authentication record. Those fields are only
        returned to your own signed-in session, through <code>/api/auth/me</code>.
      </p>
      <h2>Blind rooms and aliases</h2>
      <p>
        Matching never reads gender or nationality. Each time you join a room, Canopy deals you an
        alias such as Cobalt Fox and an ID that only means something inside that room. No message,
        private chat, reaction, vote, or call signal carries your name, email, gender, nationality,
        or account ID.
      </p>
      <h2>Private chats</h2>
      <p>
        A private chat belongs to the two people in it. Its messages, typing, files, search results,
        and calls are delivered to those two members and to nobody else in the room.
      </p>
      <h2>Leaving rooms</h2>
      <p>
        When you leave a room, Canopy removes your membership at once and records that you opted
        out, so later matches place you somewhere else.
      </p>
    </Legal>
  );
}

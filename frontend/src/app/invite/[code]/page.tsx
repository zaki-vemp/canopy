import { InviteClient } from './InviteClient';

// The static build writes this one page; the host serves it for every code.
export function generateStaticParams() {
  return [{ code: '_' }];
}

export default function InvitePage() {
  return <InviteClient />;
}

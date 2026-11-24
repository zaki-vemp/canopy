'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { apiFetch } from '@/lib/api';
import { authRevisionAtom, performLogout } from '@/state/authAtoms';
import {
  accountDrawerOpenAtom,
  activePodIdAtom,
  peerReadByConvoAtom,
  presenceByPodAtom,
  typingByConvoAtom,
  unreadByConvoAtom,
  voicePeersByPodAtom,
} from '@/state/workspaceAtoms';
import { useVoiceActions } from '@/state/voiceEngine';
import { useOpenRooms } from '@/state/roomActions';
import { Dialog } from '@/components/pieces/Dialog';
import type { PlanTier, SelfUser } from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import d from './dialogs.module.css';

export function AccountDialog({ user }: { user: SelfUser }) {
  const [open, setOpen] = useAtom(accountDrawerOpenAtom);
  return open ? <Account key={user.userId} user={user} onClose={() => setOpen(false)} /> : null;
}

function Account({ user, onClose }: { user: SelfUser; onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const openRooms = useOpenRooms();
  const revision = useAtomValue(authRevisionAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const setPresence = useSetAtom(presenceByPodAtom);
  const setVoicePeers = useSetAtom(voicePeersByPodAtom);
  const setTyping = useSetAtom(typingByConvoAtom);
  const setUnread = useSetAtom(unreadByConvoAtom);
  const setPeerRead = useSetAtom(peerReadByConvoAtom);
  const { leaveVoice, endDmCall } = useVoiceActions();

  const [fullName, setFullName] = useState(user.fullName);
  const [gender, setGender] = useState(user.gender);
  const [nationality, setNationality] = useState(user.nationalityCode);
  const pro = user.planTier === 'PREMIUM';

  const keep = (res: { user: SelfUser }) =>
    queryClient.setQueryData(['auth', 'me', revision], res);
  const save = useMutation({
    mutationFn: () =>
      apiFetch<{ user: SelfUser }>('/api/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: fullName.trim(),
          gender: gender.trim(),
          nationalityCode: nationality.trim().toUpperCase(),
        }),
      }),
    onSuccess: keep,
  });
  const plan = useMutation({
    mutationFn: (planTier: PlanTier) =>
      apiFetch<{ user: SelfUser }>('/api/auth/plan', {
        method: 'POST',
        body: JSON.stringify({ planTier }),
      }),
    onSuccess: keep,
  });
  const error = save.error ?? plan.error;

  const logOut = async () => {
    leaveVoice();
    endDmCall();
    await performLogout();
    queryClient.clear();
    setActivePodId(null);
    setPresence({});
    setVoicePeers({});
    setTyping({});
    setUnread({});
    setPeerRead({});
    onClose();
    router.replace('/login');
  };

  return (
    <Dialog
      title="Your account"
      lead="Only you ever see this page. Rooms get your alias and nothing else."
      onClose={onClose}
      foot={
        <>
          <button type="button" className={ui.btn} onClick={logOut}>
            Log out
          </button>
          <button type="submit" form="account" className={`${ui.btn} ${ui.big} ${ui.blue}`} disabled={save.isPending}>
            {save.isSuccess ? 'Saved' : 'Save changes'}
          </button>
        </>
      }
    >
      {error && (
        <p className={ui.alert} role="alert">
          {error.message}
        </p>
      )}

      <section className={d.plan} data-pro={pro ? '' : undefined} aria-label="Plan">
        <div>
          <h3>{pro ? 'Canopy Pro' : 'Free'}</h3>
          <p>
            {pro
              ? 'You can start groups you run yourself, kept to an invite or listed for anyone.'
              : 'Every matched room, with votes, calls and private chats. Pro adds groups you run yourself.'}
          </p>
        </div>
        <div className={ui.row}>
          {pro && (
            <button
              type="button"
              className={`${ui.btn} ${ui.ink}`}
              onClick={() => {
                onClose();
                openRooms('custom');
              }}
            >
              Start a group
            </button>
          )}
          <button
            type="button"
            className={`${ui.btn} ${ui.glass}`}
            disabled={plan.isPending}
            onClick={() => plan.mutate(pro ? 'FREE' : 'PREMIUM')}
          >
            {pro ? 'Go back to Free' : 'Switch to Pro'}
          </button>
        </div>
      </section>

      <form
        id="account"
        className={ui.stack}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className={ui.field}>
          <span>Email</span>
          <input className={ui.input} type="email" value={user.email} readOnly />
        </label>
        <label className={ui.field}>
          <span>Full name</span>
          <input className={ui.input} value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required />
        </label>
        <div className={ui.two}>
          <label className={ui.field}>
            <span>Gender</span>
            <input className={ui.input} value={gender} onChange={(e) => setGender(e.target.value)} required />
          </label>
          <label className={ui.field}>
            <span>Nationality, two letters</span>
            <input
              className={ui.input}
              value={nationality}
              onChange={(e) => setNationality(e.target.value.toUpperCase())}
              maxLength={2}
              required
            />
          </label>
        </div>
      </form>
      <a className={ui.btn} style={{ justifySelf: 'start' }} href="/register?fresh=1" target="_blank" rel="noopener">
        Open a second account in a new tab
      </a>
    </Dialog>
  );
}

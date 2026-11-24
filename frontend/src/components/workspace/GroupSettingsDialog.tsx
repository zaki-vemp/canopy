'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAtom } from 'jotai';
import { apiFetch } from '@/lib/api';
import { adminSettingsPodIdAtom } from '@/state/workspaceAtoms';
import { mergePod, roomName } from '@/state/roomActions';
import { Dialog } from '@/components/pieces/Dialog';
import { SizeChoice } from '@/components/workspace/SizeChoice';
import type { PodDetail, UpdatePodSettingsRequest } from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';

export function GroupSettingsDialog({ pods }: { pods: PodDetail[] }) {
  const [podId, setPodId] = useAtom(adminSettingsPodIdAtom);
  const pod = pods.find((p) => p.podId === podId);
  return pod ? <Settings key={pod.podId} pod={pod} onClose={() => setPodId(null)} /> : null;
}

export function VisibilityChoice({
  listed,
  onChange,
}: {
  listed: boolean;
  onChange: (listed: boolean) => void;
}) {
  return (
    <div className={ui.choices} role="group" aria-label="Who can find it">
      <button type="button" className={ui.choice} aria-pressed={!listed} onClick={() => onChange(false)}>
        Invite only
        <small>People need your link</small>
      </button>
      <button type="button" className={ui.choice} aria-pressed={listed} onClick={() => onChange(true)}>
        Listed
        <small>Anyone on Canopy can join</small>
      </button>
    </div>
  );
}

function Settings({ pod, onClose }: { pod: PodDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(pod.title);
  const [description, setDescription] = useState(pod.description);
  const [size, setSize] = useState<10 | 25 | 50>(
    pod.maxMembers <= 10 ? 10 : pod.maxMembers <= 25 ? 25 : 50
  );
  const [listed, setListed] = useState(pod.isPublicized);
  const [open, setOpen] = useState(pod.isOpen !== false);

  const save = useMutation({
    mutationFn: (payload: UpdatePodSettingsRequest) =>
      apiFetch<{ pod: PodDetail }>(`/api/pods/${pod.podId}/settings`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: (res) => {
      mergePod(queryClient, res.pod);
      queryClient.invalidateQueries({ queryKey: ['publicized-pods'] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      title: title.trim(),
      description: description.trim(),
      maxMembers: size,
      isPublicized: listed,
      isOpen: open,
    });
  };

  return (
    <Dialog
      title={`Manage ${roomName(pod)}`}
      lead="You and the admins you picked can change these without a vote."
      onClose={onClose}
      foot={
        <>
          <span>{save.isSuccess ? 'Saved.' : pod.code}</span>
          <button type="submit" form="group-settings" className={`${ui.btn} ${ui.big} ${ui.blue}`} disabled={save.isPending}>
            Save changes
          </button>
        </>
      }
    >
      <form id="group-settings" className={ui.stack} onSubmit={submit}>
        {save.error && (
          <p className={ui.alert} role="alert">
            {save.error.message}
          </p>
        )}
        <label className={ui.field}>
          <span>Name</span>
          <input className={ui.input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required />
        </label>
        <label className={ui.field}>
          <span>What it is about</span>
          <input className={ui.input} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={240} />
        </label>
        <div className={ui.field}>
          <span>Size</span>
          <SizeChoice value={size} onChange={(v) => v && setSize(v)} />
        </div>
        <div className={ui.field}>
          <span>Who can find it</span>
          <VisibilityChoice listed={listed} onChange={setListed} />
        </div>
        <div className={ui.field}>
          <span>New people</span>
          <div className={ui.choices} role="group" aria-label="New people">
            <button type="button" className={ui.choice} aria-pressed={open} onClick={() => setOpen(true)}>
              Can join
            </button>
            <button type="button" className={ui.choice} aria-pressed={!open} onClick={() => setOpen(false)}>
              Not for now
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

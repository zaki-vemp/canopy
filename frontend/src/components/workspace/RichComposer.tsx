'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  BarChart2,
  Bold,
  Code,
  EyeOff,
  Italic,
  Mic,
  Paperclip,
  Quote,
  Scale,
  Send,
  Square,
  X,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import {
  activePodIdAtom,
  draftByConvoAtom,
  interestModalOpenAtom,
  inviteModalPodIdAtom,
  presenceByPodAtom,
  proposeSheetOpenAtom,
  quoteTargetByConvoAtom,
  rightPanelAtom,
  typingByConvoAtom,
} from '@/state/workspaceAtoms';
import {
  sendPodWsFrame,
  syncProposalIntoCaches,
  upsertConversationMessageInCache,
} from '@/state/wsPodClient';
import { useVoiceActions } from '@/state/voiceEngine';
import {
  conversationKey,
  parseKickCommandTarget,
  type AttachmentItem,
  type PodDetail,
  type PodInviteDto,
  type PodMember,
  type PodProposalDto,
  type PostMessageResponse,
} from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

interface SlashCommandSpec {
  cmd: string;
  insert: string;
  description: string;
  groupOnly?: boolean;
}

const SLASH_COMMANDS: SlashCommandSpec[] = [
  {
    cmd: '/propose',
    insert: '/propose',
    description: 'Open pod governance proposals & start a YES/NO vote',
    groupOnly: true,
  },
  {
    cmd: '/kick',
    insert: '/kick @',
    description: 'Start a YES/NO vote-kick (or admin kick) for @Alias',
    groupOnly: true,
  },
  {
    cmd: '/poll',
    insert: '/poll "What should we play?" "Option 1" "Option 2"',
    description: 'Create an interactive live poll in Group Chat',
    groupOnly: true,
  },
  {
    cmd: '/icebreaker',
    insert: '/icebreaker',
    description: 'Post a curated question for this pod’s interest',
    groupOnly: true,
  },
  {
    cmd: '/status',
    insert: '/status ',
    description: 'Update your room-scoped pod status',
  },
  {
    cmd: '/shrug',
    insert: '/shrug ',
    description: 'Append ¯\\_(ツ)_/¯ to your message',
  },
  {
    cmd: '/invite',
    insert: '/invite',
    description: 'Share an invite link or code for this blind pod',
    groupOnly: true,
  },
  {
    cmd: '/rematch',
    insert: '/rematch',
    description: 'Opt out and switch to another random 25-member pod',
    groupOnly: true,
  },
  {
    cmd: '/leave',
    insert: '/leave',
    description: 'Leave this pod cleanly',
    groupOnly: true,
  },
];

function buildFallbackWavBlob(durationMs = 1800): Blob {
  const sampleRate = 16000;
  const numSamples = Math.max(
    1600,
    Math.floor((sampleRate * durationMs) / 1000)
  );
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const env = Math.sin(Math.min(Math.PI, t * Math.PI * 2));
    const sample =
      0.22 *
      env *
      (Math.sin(2 * Math.PI * 260 * t) + 0.5 * Math.sin(2 * Math.PI * 390 * t));
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

interface RichComposerProps {
  pod: PodDetail;
  allPods: PodDetail[];
  activePeer: PodMember | null;
  members: PodMember[];
}

export function RichComposer({
  pod,
  allPods,
  activePeer,
  members,
}: RichComposerProps) {
  const queryClient = useQueryClient();
  const activePeerId = activePeer?.peerId ?? null;
  const isGroupChat = activePeerId === null;
  const convoKey = conversationKey(pod.podId, activePeerId);

  const [draft, setDraft] = useAtom(draftByConvoAtom(convoKey));
  const [quoteTarget, setQuoteTarget] = useAtom(
    quoteTargetByConvoAtom(convoKey)
  );
  const typingByConvo = useAtomValue(typingByConvoAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const setInterestOpen = useSetAtom(interestModalOpenAtom);
  const setInviteModalPodId = useSetAtom(inviteModalPodIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);
  const setProposeOpen = useSetAtom(proposeSheetOpenAtom);
  const setPresenceByPod = useSetAtom(presenceByPodAtom);
  const { session: voiceSession, leaveVoice } = useVoiceActions();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [pendingAttachments, setPendingAttachments] = useState<AttachmentItem[]>(
    []
  );
  const [uploading, setUploading] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);

  // Poll wizard & formatting bar state
  const [pollWizardOpen, setPollWizardOpen] = useState(false);
  const [fmtBarOpen, setFmtBarOpen] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);

  // Autocomplete selection index
  const [menuIndex, setMenuIndex] = useState(0);

  // Voice Note MediaRecorder state
  const [recording, setRecording] = useState(false);
  const [recordElapsedMs, setRecordElapsedMs] = useState(0);
  const [recordingSynthFallback, setRecordingSynthFallback] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<BlobPart[]>([]);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordAudioCtxRef = useRef<AudioContext | null>(null);
  const recordStartRef = useRef<number>(0);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Typing debounce timers
  const lastTypingSentRef = useRef<number>(0);
  const stopTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setPendingAttachments([]);
    setPollWizardOpen(false);
    setComposerError(null);
    lastTypingSentRef.current = 0;
  }, [convoKey]);

  useEffect(() => {
    return () => {
      if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    };
  }, []);

  const emitTyping = (isTyping: boolean) => {
    if (isTyping) {
      const now = Date.now();
      if (now - lastTypingSentRef.current > 1500) {
        lastTypingSentRef.current = now;
        sendPodWsFrame({
          type: 'typing',
          targetPeerId: activePeerId,
          isTyping: true,
        });
      }
      if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
      stopTypingTimerRef.current = setTimeout(() => {
        sendPodWsFrame({
          type: 'typing',
          targetPeerId: activePeerId,
          isTyping: false,
        });
      }, 2400);
    } else {
      if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
      lastTypingSentRef.current = 0;
      sendPodWsFrame({
        type: 'typing',
        targetPeerId: activePeerId,
        isTyping: false,
      });
    }
  };

  const availableCommands = useMemo(
    () => SLASH_COMMANDS.filter((c) => isGroupChat || !c.groupOnly),
    [isGroupChat]
  );

  // Detect Slash command menu
  const slashMatches = useMemo(() => {
    if (!draft.startsWith('/') || draft.includes('\n')) return [];
    const firstToken = draft.split(/\s+/)[0].toLowerCase();
    if (draft.includes(' ') && firstToken !== draft.toLowerCase()) return [];
    return availableCommands.filter((c) => c.cmd.startsWith(firstToken));
  }, [availableCommands, draft]);

  // Detect @mention menu
  const mentionQuery = useMemo(() => {
    if (slashMatches.length > 0) return null;
    const match = /(?:^|\s)@([a-zA-Z0-9 ]*)$/.exec(draft);
    if (!match) return null;
    const q = match[1].toLowerCase();
    const isKickPrefix = /^\/kick\s+/i.test(draft);
    const pool = activePeer ? [activePeer] : members;
    const candidates = [
      ...(isKickPrefix || activePeer
        ? []
        : [{ alias: 'here', subtitle: 'Notify Pod Group Chat' }]),
      ...pool
        .filter((m) => !isKickPrefix || m.peerId !== pod.myPeerId)
        .map((m) => ({
          alias: m.alias,
          subtitle: m.online ? 'Online in pod' : 'Pod member',
        })),
    ];
    return candidates.filter((c) => c.alias.toLowerCase().includes(q));
  }, [activePeer, draft, members, pod.myPeerId, slashMatches.length]);

  useEffect(() => {
    setMenuIndex(0);
  }, [slashMatches.length, mentionQuery?.length]);

  const leaveOrRematch = async (rematch: boolean) => {
    if (voiceSession.podId === pod.podId) {
      leaveVoice();
    }
    const res = await apiFetch<{ leftPodId: string; newPod: PodDetail | null }>(
      `/api/pods/${pod.podId}/leave`,
      {
        method: 'POST',
        body: JSON.stringify({ rematch }),
      }
    );
    const remaining = allPods.filter((p) => p.podId !== res.leftPodId);
    const nextList = res.newPod ? [...remaining, res.newPod] : remaining;
    queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], {
      pods: nextList,
    });
    setDraft('');
    if (res.newPod) {
      setActivePodId(res.newPod.podId);
    } else if (nextList[0]) {
      setActivePodId(nextList[0].podId);
    } else {
      setActivePodId(null);
      setInterestOpen(true);
    }
  };

  const openGovernanceSheet = () => {
    setProposeOpen(true);
    setRightPanel('votes');
  };

  const sendMutation = useMutation({
    mutationFn: async (payload: {
      body: string;
      attachmentIds: number[];
      quoteMessageId: number;
    }) => {
      const trimmed = payload.body.trim();
      if (isGroupChat && /^\/propose(?:\s|$)/i.test(trimmed)) {
        openGovernanceSheet();
        return { commandHandled: 'propose' } as PostMessageResponse;
      }
      if (isGroupChat && /^\/kick(?:\s|$)/i.test(trimmed)) {
        const parsed = parseKickCommandTarget(trimmed, members, pod.myPeerId);
        if (!parsed) {
          throw new Error(
            'Usage: /kick @Alias [optional reason] — select another active pod member.'
          );
        }
        if (pod.governanceMode === 'ADMIN') {
          if (pod.myRole !== 'OWNER' && pod.myRole !== 'ADMIN') {
            throw new Error(
              'Only the group owner or admins can kick members in a custom admin group.'
            );
          }
          const res = await apiFetch<{ pod: PodDetail }>(
            `/api/pods/${pod.podId}/admin/kick`,
            {
              method: 'POST',
              body: JSON.stringify({ targetPeerId: parsed.target.peerId }),
            }
          );
          queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) =>
            old
              ? {
                  pods: old.pods.map((p) =>
                    p.podId === res.pod.podId
                      ? {
                          ...p,
                          ...res.pod,
                          dmConversations:
                            res.pod.dmConversations &&
                            res.pod.dmConversations.length > 0
                              ? res.pod.dmConversations
                              : p.dmConversations,
                        }
                      : p
                  ),
                }
              : { pods: [res.pod] }
          );
          setPresenceByPod((prev) => {
            const snap = prev[pod.podId];
            if (!snap) return prev;
            return {
              ...prev,
              [pod.podId]: {
                ...snap,
                members: res.pod.members,
              },
            };
          });
          return { commandHandled: 'kick' } as PostMessageResponse;
        }
        const res = await apiFetch<{
          proposal: PodProposalDto;
          pod?: PodDetail | null;
        }>(`/api/pods/${pod.podId}/proposals`, {
          method: 'POST',
          body: JSON.stringify({
            kind: 'KICK_MEMBER',
            targetPeerId: parsed.target.peerId,
            reason: parsed.reason || undefined,
          }),
        });
        syncProposalIntoCaches(queryClient, pod.podId, res.proposal, res.pod);
        queryClient.invalidateQueries({
          queryKey: ['messages', pod.podId, 'group'],
        });
        queryClient.invalidateQueries({ queryKey: ['pods'] });
        setRightPanel('votes');
        return { commandHandled: 'kick' } as PostMessageResponse;
      }
      if (isGroupChat && trimmed === '/invite') {
        setInviteModalPodId(pod.podId);
        try {
          const res = await apiFetch<{ invite: PodInviteDto }>(
            `/api/pods/${pod.podId}/invites`,
            {
              method: 'POST',
              body: JSON.stringify({
                maxUses: 0,
                expiresInHours: 168,
                regenerate: false,
              }),
            }
          );
          if (
            typeof window !== 'undefined' &&
            navigator.clipboard?.writeText
          ) {
            await navigator.clipboard.writeText(
              `${window.location.origin}/invite/${res.invite.code}`
            );
          }
        } catch {
          // PodInviteModal displays any invite API errors
        }
        return { commandHandled: 'invite' } as PostMessageResponse;
      }
      if (isGroupChat && trimmed === '/rematch') {
        await leaveOrRematch(true);
        return { commandHandled: 'rematch' } as PostMessageResponse;
      }
      if (isGroupChat && trimmed === '/leave') {
        await leaveOrRematch(false);
        return { commandHandled: 'leave' } as PostMessageResponse;
      }
      if (trimmed.startsWith('/status ')) {
        const customStatus = trimmed.slice('/status '.length).trim();
        await apiFetch<{ ok: boolean }>(`/api/pods/${pod.podId}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ customStatus }),
        });
        queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) => {
          if (!old) return old;
          return {
            pods: old.pods.map((p) =>
              p.podId === pod.podId ? { ...p, myStatus: customStatus } : p
            ),
          };
        });
        return { commandHandled: 'status' } as PostMessageResponse;
      }

      const endpoint = activePeerId
        ? `/api/pods/${pod.podId}/dms/${encodeURIComponent(
            activePeerId
          )}/messages`
        : `/api/pods/${pod.podId}/messages`;

      return apiFetch<PostMessageResponse>(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          body: payload.body,
          quoteMessageId: payload.quoteMessageId,
          attachmentIds: payload.attachmentIds,
        }),
      });
    },
    onSuccess: (res) => {
      setComposerError(null);
      setDraft('');
      setQuoteTarget(null);
      setPendingAttachments([]);
      emitTyping(false);
      if (res?.message) {
        upsertConversationMessageInCache(
          queryClient,
          pod.podId,
          res.message,
          pod.myPeerId
        );
      }
    },
    onError: (err: Error) => {
      setComposerError(err.message || 'Could not send message');
    },
  });

  const uploadAttachmentFile = async (
    file: File | Blob,
    fileName: string,
    kind: 'image' | 'file' | 'voice_note',
    durationMs = 0
  ): Promise<AttachmentItem> => {
    const fd = new FormData();
    fd.append('file', file, fileName);
    fd.append('kind', kind);
    fd.append('durationMs', String(Math.round(durationMs)));
    return apiFetch<AttachmentItem>(`/api/pods/${pod.podId}/attachments`, {
      method: 'POST',
      body: fd,
    });
  };

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setComposerError(null);
    try {
      const kind = file.type.startsWith('image/') ? 'image' : 'file';
      const uploaded = await uploadAttachmentFile(file, file.name, kind, 0);
      setPendingAttachments((prev) => [...prev, uploaded]);
    } catch (err) {
      setComposerError(
        err instanceof Error ? err.message : 'Attachment upload failed'
      );
    } finally {
      setUploading(false);
    }
  };

  const wrapSelection = (
    prefix: string,
    suffix: string,
    placeholder: string
  ) => {
    const el = textareaRef.current;
    if (!el) {
      setDraft(`${draft}${prefix}${placeholder}${suffix}`);
      return;
    }
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const selected = draft.slice(start, end) || placeholder;
    const next = `${draft.slice(0, start)}${prefix}${selected}${suffix}${draft.slice(end)}`;
    setDraft(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(
        start + prefix.length,
        start + prefix.length + selected.length
      );
    });
  };

  const applySlashCommand = (spec: SlashCommandSpec) => {
    if (spec.cmd === '/propose') {
      setDraft('');
      emitTyping(false);
      openGovernanceSheet();
      return;
    }
    if (spec.cmd === '/invite') {
      setDraft('');
      emitTyping(false);
      sendMutation.mutate({
        body: '/invite',
        attachmentIds: [],
        quoteMessageId: 0,
      });
      return;
    }
    setDraft(spec.insert);
    textareaRef.current?.focus();
  };

  const applyMention = (alias: string) => {
    const replaced = draft.replace(/(?:^|\s)@([a-zA-Z0-9 ]*)$/, (m) => {
      const leading = m.startsWith(' ') ? ' ' : '';
      return `${leading}@${alias} `;
    });
    setDraft(replaced);
    textareaRef.current?.focus();
  };

  const submitCurrent = () => {
    if (sendMutation.isPending || uploading) return;
    const trimmed = draft.trim();
    if (!trimmed && pendingAttachments.length === 0) return;

    sendMutation.mutate({
      body: trimmed,
      attachmentIds: pendingAttachments.map((a) => a.id),
      quoteMessageId: quoteTarget?.id || 0,
    });
  };

  const cleanupRecordingResources = () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (recordStreamRef.current) {
      recordStreamRef.current.getTracks().forEach((t) => t.stop());
      recordStreamRef.current = null;
    }
    if (recordAudioCtxRef.current) {
      recordAudioCtxRef.current.close().catch(() => {});
      recordAudioCtxRef.current = null;
    }
    recorderRef.current = null;
  };

  const startVoiceNoteRecording = async () => {
    setComposerError(null);
    recordChunksRef.current = [];
    let stream: MediaStream | null = null;
    let synthUsed = false;

    if (
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
    ) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordStreamRef.current = stream;
      } catch {
        synthUsed = true;
      }
    } else {
      synthUsed = true;
    }

    if (!stream) {
      try {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new Ctor();
        await ctx.resume().catch(() => {});
        const dest = ctx.createMediaStreamDestination();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = 260;
        gain.gain.value = 0.16;
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
        recordAudioCtxRef.current = ctx;
        stream = dest.stream;
      } catch {
        stream = null;
      }
    }

    setRecordingSynthFallback(synthUsed);
    recordStartRef.current = Date.now();
    setRecordElapsedMs(0);
    setRecording(true);

    recordTimerRef.current = setInterval(() => {
      setRecordElapsedMs(Date.now() - recordStartRef.current);
    }, 200);

    if (stream && typeof MediaRecorder !== 'undefined') {
      try {
        const preferredMime = MediaRecorder.isTypeSupported(
          'audio/webm;codecs=opus'
        )
          ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/webm')
            ? 'audio/webm'
            : '';
        const mr = preferredMime
          ? new MediaRecorder(stream, { mimeType: preferredMime })
          : new MediaRecorder(stream);
        mr.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) {
            recordChunksRef.current.push(ev.data);
          }
        };
        mr.start(150);
        recorderRef.current = mr;
      } catch {
        recorderRef.current = null;
      }
    }
  };

  const cancelVoiceNoteRecording = () => {
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
    } catch {
      // ignore
    }
    cleanupRecordingResources();
    setRecording(false);
    setRecordElapsedMs(0);
  };

  const finishAndSendVoiceNote = async () => {
    const durationMs = Math.max(800, Date.now() - recordStartRef.current);
    const mr = recorderRef.current;

    let audioBlob: Blob | null = null;
    let ext = 'webm';

    if (mr && mr.state !== 'inactive') {
      audioBlob = await new Promise<Blob>((resolve) => {
        mr.onstop = () => {
          const mime = mr.mimeType || 'audio/webm';
          if (mime.includes('mp4')) ext = 'm4a';
          resolve(new Blob(recordChunksRef.current, { type: mime }));
        };
        mr.stop();
      });
    }

    cleanupRecordingResources();
    setRecording(false);

    if (!audioBlob || audioBlob.size === 0) {
      audioBlob = buildFallbackWavBlob(durationMs);
      ext = 'wav';
    }

    setUploading(true);
    try {
      const uploaded = await uploadAttachmentFile(
        audioBlob,
        `voice-note-${Date.now()}.${ext}`,
        'voice_note',
        durationMs
      );
      sendMutation.mutate({
        body: draft.trim(),
        attachmentIds: [uploaded.id],
        quoteMessageId: quoteTarget?.id || 0,
      });
    } catch (err) {
      setComposerError(
        err instanceof Error ? err.message : 'Could not upload voice note'
      );
    } finally {
      setUploading(false);
      setRecordElapsedMs(0);
    }
  };

  const submitPollWizard = (e: React.FormEvent) => {
    e.preventDefault();
    const q = pollQuestion.trim();
    const opts = pollOptions.map((o) => o.trim()).filter(Boolean);
    if (!q || opts.length < 2) return;
    const escaped = [q, ...opts]
      .map((s) => `"${s.replace(/"/g, "'")}"`)
      .join(' ');
    sendMutation.mutate({
      body: `/poll ${escaped}`,
      attachmentIds: [],
      quoteMessageId: 0,
    });
    setPollQuestion('');
    setPollOptions(['', '']);
    setPollWizardOpen(false);
  };

  const activeTypers = (typingByConvo[convoKey] || []).filter(
    (alias) => alias !== pod.myAlias
  );

  const placeholderText = activePeer
    ? `Message ${activePeer.alias} privately...`
    : `Message Group Chat as ${pod.myAlias}...`;

  return (
    <div className={styles.composerOuter}>
      <div className={styles.typingBar} aria-live="polite">
        {activeTypers.length === 1 && `${activeTypers[0]} is typing...`}
        {activeTypers.length === 2 &&
          `${activeTypers[0]} and ${activeTypers[1]} are typing...`}
        {activeTypers.length > 2 &&
          `${activeTypers.slice(0, 2).join(', ')} and others are typing...`}
      </div>

      {composerError && (
        <div
          style={{
            marginBottom: 6,
            padding: '6px 10px',
            borderRadius: 8,
            background: '#fef3f2',
            color: '#b42318',
            fontSize: 12.5,
          }}
          role="alert"
        >
          {composerError}
        </div>
      )}

      <div className={styles.composerCard}>
        {/* Slash Command Autocomplete */}
        {slashMatches.length > 0 && (
          <div
            className={styles.autocompleteMenu}
            role="listbox"
            aria-label="Slash commands"
          >
            {slashMatches.map((spec, idx) => (
              <button
                key={spec.cmd}
                type="button"
                className={`${styles.autocompleteItem} ${
                  idx === menuIndex ? styles.autocompleteItemActive : ''
                }`}
                onClick={() => applySlashCommand(spec)}
              >
                <strong style={{ fontFamily: 'var(--m-font-mono)' }}>
                  {spec.cmd}
                </strong>
                <span style={{ color: '#686868', fontSize: 12 }}>
                  {spec.description}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* @Alias Autocomplete */}
        {mentionQuery && mentionQuery.length > 0 && (
          <div
            className={styles.autocompleteMenu}
            role="listbox"
            aria-label="Mention pod alias"
          >
            {mentionQuery.map((item, idx) => (
              <button
                key={item.alias}
                type="button"
                className={`${styles.autocompleteItem} ${
                  idx === menuIndex ? styles.autocompleteItemActive : ''
                }`}
                onClick={() => applyMention(item.alias)}
              >
                <strong>@{item.alias}</strong>
                <span style={{ color: '#686868', fontSize: 12 }}>
                  {item.subtitle}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Quote Reply Banner */}
        {quoteTarget && (
          <div className={styles.composerQuoteBanner}>
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              Replying to <strong>{quoteTarget.senderAlias}</strong>:{' '}
              {quoteTarget.body || 'Attachment'}
            </span>
            <button
              type="button"
              className={styles.iconSmallBtn}
              onClick={() => setQuoteTarget(null)}
              aria-label="Cancel quote reply"
            >
              <X size={15} />
            </button>
          </div>
        )}

        {/* Inline Poll Wizard (Group Chat only) */}
        {isGroupChat && pollWizardOpen && (
          <form
            onSubmit={submitPollWizard}
            style={{
              padding: 12,
              background: '#f5f7f5',
              borderBottom: '1px solid rgba(35,35,35,0.1)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <strong style={{ fontSize: 13 }}>Create Group Poll</strong>
              <button
                type="button"
                className={styles.iconSmallBtn}
                onClick={() => setPollWizardOpen(false)}
                aria-label="Close poll builder"
              >
                <X size={15} />
              </button>
            </div>
            <input
              type="text"
              value={pollQuestion}
              onChange={(e) => setPollQuestion(e.target.value)}
              placeholder="Poll question (e.g. What game tonight?)"
              required
              className={styles.statusInput}
              aria-label="Poll question"
            />
            {pollOptions.map((opt, i) => (
              <input
                key={i}
                type="text"
                value={opt}
                onChange={(e) => {
                  const next = [...pollOptions];
                  next[i] = e.target.value;
                  setPollOptions(next);
                }}
                placeholder={`Option ${i + 1}`}
                required={i < 2}
                className={styles.statusInput}
                aria-label={`Poll option ${i + 1}`}
              />
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              {pollOptions.length < 5 && (
                <button
                  type="button"
                  className={styles.statusSaveBtn}
                  onClick={() => setPollOptions([...pollOptions, ''])}
                >
                  + Option
                </button>
              )}
              <button
                type="submit"
                className={styles.statusSaveBtn}
                style={{ background: '#a1ffcb', borderColor: '#1f6b3a' }}
              >
                Post Poll
              </button>
            </div>
          </form>
        )}

        {/* Pending File/Image Chips */}
        {pendingAttachments.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              padding: '8px 12px 0',
            }}
          >
            {pendingAttachments.map((att) => (
              <span
                key={att.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 9px',
                  borderRadius: 7,
                  background: '#eafbef',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                <span>{att.fileName}</span>
                <button
                  type="button"
                  onClick={() =>
                    setPendingAttachments((prev) =>
                      prev.filter((x) => x.id !== att.id)
                    )
                  }
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                  aria-label={`Remove ${att.fileName}`}
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Collapsible Formatting Toolbar (toggled by Aa) */}
        {fmtBarOpen && (
          <div
            className={`${styles.formatToolbar} ${styles.formatToolbarOpen}`}
            role="toolbar"
            aria-label="Text formatting"
          >
            <button
              type="button"
              className={styles.fmtBtn}
              onClick={() => wrapSelection('**', '**', 'bold')}
              aria-label="Bold"
              title="Bold"
            >
              <Bold size={15} />
            </button>
            <button
              type="button"
              className={styles.fmtBtn}
              onClick={() => wrapSelection('*', '*', 'italic')}
              aria-label="Italic"
              title="Italic"
            >
              <Italic size={15} />
            </button>
            <button
              type="button"
              className={styles.fmtBtn}
              onClick={() => wrapSelection('`', '`', 'code')}
              aria-label="Inline code"
              title="Code"
            >
              <Code size={15} />
            </button>
            <button
              type="button"
              className={styles.fmtBtn}
              onClick={() => wrapSelection('> ', '', 'quote')}
              aria-label="Blockquote"
              title="Quote"
            >
              <Quote size={15} />
            </button>
            <button
              type="button"
              className={styles.fmtBtn}
              onClick={() => wrapSelection('||', '||', 'spoiler')}
              aria-label="Spoiler tag"
              title="Spoiler (||text||)"
            >
              <EyeOff size={15} />
            </button>
          </div>
        )}

        {/* Clean Chat Input Bar: Clip + Aa + Group Quick Chips + Input + Mic + Mint Send */}
        <div className={styles.composerInputRow}>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={handleFilePick}
          />
          <button
            type="button"
            className={styles.composerIconBtn}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            aria-label="Upload attachment"
            title="Attach image or file"
          >
            <Paperclip size={18} />
          </button>

          <button
            type="button"
            className={`${styles.composerIconBtn} ${styles.fmtToggleBtn} ${
              fmtBarOpen ? styles.mobileFmtToggleBtnActive : ''
            }`}
            onClick={() => setFmtBarOpen((v) => !v)}
            aria-expanded={fmtBarOpen}
            aria-label="Toggle text formatting"
            title="Text formatting (Bold, Italic, Code, Spoiler)"
          >
            Aa
          </button>

          {isGroupChat && (
            <div className={styles.composerQuickChips}>
              <button
                type="button"
                className={`${styles.composerChipBtn} ${
                  pollWizardOpen ? styles.composerChipBtnActive : ''
                }`}
                onClick={() => setPollWizardOpen((v) => !v)}
                aria-label="Create group poll"
                title="Create /poll in Group Chat"
              >
                <BarChart2 size={14} />
                <span>/poll</span>
              </button>

              {pod.governanceMode !== 'ADMIN' && (
                <button
                  type="button"
                  className={styles.composerChipBtn}
                  onClick={openGovernanceSheet}
                  aria-label="Propose democratic pod vote"
                  title="Open /propose democratic vote sheet"
                >
                  <Scale size={14} />
                  <span>/propose</span>
                </button>
              )}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              emitTyping(e.target.value.trim().length > 0);
            }}
            onKeyDown={(e) => {
              if (slashMatches.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMenuIndex((i) => (i + 1) % slashMatches.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMenuIndex(
                    (i) => (i - 1 + slashMatches.length) % slashMatches.length
                  );
                  return;
                }
                if (e.key === 'Tab') {
                  e.preventDefault();
                  applySlashCommand(slashMatches[menuIndex] || slashMatches[0]);
                  return;
                }
              }

              if (mentionQuery && mentionQuery.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMenuIndex((i) => (i + 1) % mentionQuery.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMenuIndex(
                    (i) => (i - 1 + mentionQuery.length) % mentionQuery.length
                  );
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault();
                  const chosen = mentionQuery[menuIndex] || mentionQuery[0];
                  applyMention(chosen.alias);
                  return;
                }
              }

              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitCurrent();
              }
            }}
            placeholder={placeholderText}
            rows={1}
            className={styles.composerTextarea}
            aria-label={placeholderText}
          />

          {!recording && (
            <button
              type="button"
              className={styles.composerIconBtn}
              onClick={startVoiceNoteRecording}
              disabled={uploading}
              aria-label="Record Voice Note"
              title="Record Voice Note"
            >
              <Mic size={18} />
            </button>
          )}

          <button
            type="button"
            className={styles.sendBtn}
            onClick={submitCurrent}
            disabled={
              sendMutation.isPending ||
              uploading ||
              (!draft.trim() && pendingAttachments.length === 0)
            }
            aria-label="Send message"
          >
            <Send size={16} />
            <span className={styles.sendBtnLabel}>Send</span>
          </button>
        </div>

        {/* Active Voice Note Recorder Strip */}
        {recording && (
          <div className={styles.recordingBar} role="status" aria-live="polite">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Square size={12} fill="#b42318" color="#b42318" />
              <strong style={{ fontSize: 13, color: '#b42318' }}>
                Recording Voice Note · {(recordElapsedMs / 1000).toFixed(1)}s
              </strong>
              {recordingSynthFallback && (
                <span style={{ fontSize: 11.5, color: '#686868' }}>
                  (synth clip fallback)
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className={styles.statusSaveBtn}
                onClick={cancelVoiceNoteRecording}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.statusSaveBtn}
                style={{ background: '#a1ffcb', borderColor: '#1f6b3a' }}
                onClick={finishAndSendVoiceNote}
              >
                Send Voice Note
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

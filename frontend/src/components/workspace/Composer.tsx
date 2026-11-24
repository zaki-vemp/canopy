'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { X } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { colorVar } from '@/lib/pieces';
import {
  draftByConvoAtom,
  inviteModalPodIdAtom,
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
import { roomName, useLeaveRoom, useMergeRoster } from '@/state/roomActions';
import { StatusForm, useSaveStatus } from '@/components/workspace/PeoplePanel';
import { seconds } from '@/components/workspace/blocks';
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
import ui from '@/components/pieces/ui.module.css';
import c from '@/app/app/chat.module.css';

interface SlashCommand {
  cmd: string;
  insert: string;
  does: string;
  roomOnly?: boolean;
}

const COMMANDS: SlashCommand[] = [
  { cmd: '/propose', insert: '/propose', does: 'Put a change to the room to a vote', roomOnly: true },
  { cmd: '/kick', insert: '/kick @', does: 'Vote someone out, or remove them if you run the group', roomOnly: true },
  { cmd: '/poll', insert: '/poll ', does: 'A question with up to five answers', roomOnly: true },
  { cmd: '/icebreaker', insert: '/icebreaker', does: 'Deal a question written for this hobby', roomOnly: true },
  { cmd: '/status', insert: '/status ', does: 'A line under your alias, in this room' },
  { cmd: '/shrug', insert: '/shrug ', does: '¯\\_(ツ)_/¯ after your message' },
  { cmd: '/invite', insert: '/invite', does: 'A link that lets people into this room', roomOnly: true },
  { cmd: '/rematch', insert: '/rematch', does: 'Out of this room, into another', roomOnly: true },
  { cmd: '/leave', insert: '/leave', does: 'Out of this room', roomOnly: true },
];

const FORMATS = [
  { name: 'Bold', before: '**', after: '**', text: 'bold' },
  { name: 'Italic', before: '*', after: '*', text: 'italic' },
  { name: 'Code', before: '`', after: '`', text: 'code' },
  { name: 'Quote', before: '> ', after: '', text: 'quote' },
  { name: 'Spoiler', before: '||', after: '||', text: 'spoiler' },
];

const HUM = [40, 80, 55, 95, 35, 70, 60, 88, 45, 76, 52, 92, 38, 66, 84, 48, 72, 58, 90, 42];

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

type Tray = 'poll' | 'status' | 'format' | null;

export function Composer({
  pod,
  pods,
  activePeer,
  members,
}: {
  pod: PodDetail;
  pods: PodDetail[];
  activePeer: PodMember | null;
  members: PodMember[];
}) {
  const queryClient = useQueryClient();
  const mergeRoster = useMergeRoster();
  const saveStatus = useSaveStatus(pod);
  const leave = useLeaveRoom(pods);
  const peerId = activePeer?.peerId ?? null;
  const inRoom = peerId === null;
  const proRoom = pod.governanceMode === 'ADMIN';
  const convoKey = conversationKey(pod.podId, peerId);

  const [draft, setDraft] = useAtom(draftByConvoAtom(convoKey));
  const [quote, setQuote] = useAtom(quoteTargetByConvoAtom(convoKey));
  const typing = useAtomValue(typingByConvoAtom);
  const setInvitePod = useSetAtom(inviteModalPodIdAtom);
  const setRightPanel = useSetAtom(rightPanelAtom);
  const setProposing = useSetAtom(proposeSheetOpenAtom);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState<AttachmentItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setComposerError] = useState<string | null>(null);
  const [tray, setTray] = useState<Tray>(null);
  const [menuIndex, setMenuIndex] = useState(0);

  const [recording, setRecording] = useState(false);
  const [recordElapsedMs, setRecordElapsedMs] = useState(0);
  const [recordingSynthFallback, setRecordingSynthFallback] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<BlobPart[]>([]);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const recordAudioCtxRef = useRef<AudioContext | null>(null);
  const recordStartRef = useRef<number>(0);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const lastTypingSentRef = useRef(0);
  const stopTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setPending([]);
    setTray(null);
    setComposerError(null);
    lastTypingSentRef.current = 0;
  }, [convoKey]);

  useEffect(
    () => () => {
      if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    },
    []
  );

  const emitTyping = (isTyping: boolean) => {
    const send = (on: boolean) =>
      sendPodWsFrame({ type: 'typing', targetPeerId: peerId, isTyping: on });
    if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
    if (!isTyping) {
      lastTypingSentRef.current = 0;
      send(false);
      return;
    }
    const now = Date.now();
    if (now - lastTypingSentRef.current > 1500) {
      lastTypingSentRef.current = now;
      send(true);
    }
    stopTypingTimerRef.current = setTimeout(() => send(false), 2400);
  };

  const slash = useMemo(() => {
    if (!draft.startsWith('/') || draft.includes('\n')) return [];
    const first = draft.split(/\s+/)[0].toLowerCase();
    if (draft.includes(' ') && first !== draft.toLowerCase()) return [];
    return COMMANDS.filter((x) => (inRoom || !x.roomOnly) && x.cmd.startsWith(first));
  }, [draft, inRoom]);

  const mentions = useMemo(() => {
    if (slash.length > 0) return [];
    const match = /(?:^|\s)@([a-zA-Z0-9 ]*)$/.exec(draft);
    if (!match) return [];
    const q = match[1].toLowerCase();
    const kicking = /^\/kick\s+/i.test(draft);
    const list = (activePeer ? [activePeer] : members)
      .filter((m) => !kicking || m.peerId !== pod.myPeerId)
      .map((m) => ({ alias: m.alias, note: m.online ? 'Online' : 'Away' }));
    if (!kicking && !activePeer) list.unshift({ alias: 'here', note: 'Everyone in the room' });
    return list.filter((m) => m.alias.toLowerCase().includes(q));
  }, [activePeer, draft, members, pod.myPeerId, slash.length]);

  useEffect(() => setMenuIndex(0), [slash.length, mentions.length]);

  const openVote = () => {
    setProposing(true);
    setRightPanel('votes');
  };

  const sendMutation = useMutation({
    mutationFn: async (payload: {
      body: string;
      attachmentIds: number[];
      quoteMessageId: number;
    }): Promise<PostMessageResponse> => {
      const text = payload.body.trim();
      if (inRoom && /^\/propose(?:\s|$)/i.test(text)) {
        openVote();
        return { commandHandled: 'propose' };
      }
      if (inRoom && /^\/kick(?:\s|$)/i.test(text)) {
        const parsed = parseKickCommandTarget(text, members, pod.myPeerId);
        if (!parsed) throw new Error('Type /kick @ and the alias of someone in this room.');
        if (proRoom) {
          if (pod.myRole === 'MEMBER') {
            throw new Error('Only the people who run this group can remove someone.');
          }
          const res = await apiFetch<{ pod: PodDetail }>(
            `/api/pods/${pod.podId}/admin/kick`,
            {
              method: 'POST',
              body: JSON.stringify({ targetPeerId: parsed.target.peerId }),
            }
          );
          mergeRoster(res.pod);
          return { commandHandled: 'kick' };
        }
        const res = await apiFetch<{ proposal: PodProposalDto; pod?: PodDetail | null }>(
          `/api/pods/${pod.podId}/proposals`,
          {
            method: 'POST',
            body: JSON.stringify({
              kind: 'KICK_MEMBER',
              targetPeerId: parsed.target.peerId,
              reason: parsed.reason || undefined,
            }),
          }
        );
        syncProposalIntoCaches(queryClient, pod.podId, res.proposal, res.pod);
        queryClient.invalidateQueries({ queryKey: ['messages', pod.podId, 'group'] });
        queryClient.invalidateQueries({ queryKey: ['pods'] });
        setRightPanel('votes');
        return { commandHandled: 'kick' };
      }
      if (inRoom && text === '/invite') {
        setInvitePod(pod.podId);
        try {
          const res = await apiFetch<{ invite: PodInviteDto }>(
            `/api/pods/${pod.podId}/invites`,
            {
              method: 'POST',
              body: JSON.stringify({ maxUses: 0, expiresInHours: 168, regenerate: false }),
            }
          );
          await navigator.clipboard?.writeText(
            `${window.location.origin}/invite/${res.invite.code}`
          );
        } catch {
          // the invite dialog shows any error itself
        }
        return { commandHandled: 'invite' };
      }
      if (inRoom && (text === '/rematch' || text === '/leave')) {
        await leave.mutateAsync({ podId: pod.podId, rematch: text === '/rematch' });
        return { commandHandled: text.slice(1) };
      }
      if (text.startsWith('/status ')) {
        await saveStatus.mutateAsync(text.slice('/status '.length).trim());
        return { commandHandled: 'status' };
      }
      return apiFetch<PostMessageResponse>(
        peerId
          ? `/api/pods/${pod.podId}/dms/${encodeURIComponent(peerId)}/messages`
          : `/api/pods/${pod.podId}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({
            body: payload.body,
            quoteMessageId: payload.quoteMessageId,
            attachmentIds: payload.attachmentIds,
          }),
        }
      );
    },
    onSuccess: (res) => {
      setComposerError(null);
      setDraft('');
      setQuote(null);
      setPending([]);
      emitTyping(false);
      if (res?.message) {
        upsertConversationMessageInCache(queryClient, pod.podId, res.message, pod.myPeerId);
      }
    },
    onError: (err: Error) => setComposerError(err.message || 'That did not send. Try again.'),
  });

  const sendBody = (body: string, attachmentIds: number[] = []) =>
    sendMutation.mutate({ body, attachmentIds, quoteMessageId: quote?.id || 0 });

  const uploadAttachmentFile = (
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

  const pickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setComposerError(null);
    try {
      const uploaded = await uploadAttachmentFile(
        file,
        file.name,
        file.type.startsWith('image/') ? 'image' : 'file'
      );
      setPending((prev) => [...prev, uploaded]);
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : 'The file did not upload.');
    } finally {
      setUploading(false);
    }
  };

  const wrap = (before: string, after: string, text: string) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const picked = draft.slice(start, end) || text;
    setDraft(`${draft.slice(0, start)}${before}${picked}${after}${draft.slice(end)}`);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + before.length, start + before.length + picked.length);
    });
  };

  const applyCommand = (x: SlashCommand) => {
    if (x.cmd === '/propose' || x.cmd === '/invite' || x.cmd === '/icebreaker') {
      setDraft('');
      emitTyping(false);
      if (x.cmd === '/propose') openVote();
      else sendBody(x.cmd);
      return;
    }
    if (x.cmd === '/poll' || x.cmd === '/status') {
      setDraft('');
      setTray(x.cmd === '/poll' ? 'poll' : 'status');
      return;
    }
    setDraft(x.insert);
    textareaRef.current?.focus();
  };

  const applyMention = (alias: string) => {
    setDraft(
      draft.replace(/(?:^|\s)@([a-zA-Z0-9 ]*)$/, (m) => `${m.startsWith(' ') ? ' ' : ''}@${alias} `)
    );
    textareaRef.current?.focus();
  };

  const submit = () => {
    if (sendMutation.isPending || uploading) return;
    const text = draft.trim();
    if (!text && pending.length === 0) return;
    sendBody(text, pending.map((a) => a.id));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const size = slash.length || mentions.length;
    if (size > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : size - 1)) % size);
        return;
      }
      const enter = e.key === 'Enter' && !e.shiftKey;
      if (slash.length > 0) {
        const picked = slash[menuIndex] ?? slash[0];
        // Enter runs a command that is fully typed, and completes one that still needs something.
        if (e.key === 'Tab' || (enter && (draft.trim() !== picked.cmd || picked.insert !== picked.cmd))) {
          e.preventDefault();
          applyCommand(picked);
          return;
        }
      } else if (e.key === 'Tab' || enter) {
        e.preventDefault();
        applyMention((mentions[menuIndex] ?? mentions[0]).alias);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
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
      sendBody(draft.trim(), [uploaded.id]);
    } catch (err) {
      setComposerError(
        err instanceof Error ? err.message : 'The voice note did not upload.'
      );
    } finally {
      setUploading(false);
      setRecordElapsedMs(0);
    }
  };

  const typers = (typing[convoKey] || []).filter((alias) => alias !== pod.myAlias);
  const placeholder = activePeer
    ? `Write to ${activePeer.alias} alone`
    : `Write to ${roomName(pod)}, or pick a piece`;
  const toggleTray = (t: Tray) => setTray((cur) => (cur === t ? null : t));
  const kind = (color: string) => ({ '--c': `var(--c-${color})` }) as CSSProperties;

  return (
    <div className={c.composer}>
      <div className={c.typing} aria-live="polite">
        {typers.length === 1 && `${typers[0]} is writing`}
        {typers.length === 2 && `${typers[0]} and ${typers[1]} are writing`}
        {typers.length > 2 && `${typers[0]}, ${typers[1]} and others are writing`}
      </div>

      {slash.length > 0 && (
        <div className={c.menu} role="listbox" aria-label="Commands">
          {slash.map((x, i) => (
            <button key={x.cmd} type="button" role="option" aria-selected={i === menuIndex} onClick={() => applyCommand(x)}>
              <code>{x.cmd}</code>
              <span>{x.does}</span>
            </button>
          ))}
        </div>
      )}
      {mentions.length > 0 && (
        <div className={c.menu} role="listbox" aria-label="People in the room">
          {mentions.map((m, i) => (
            <button key={m.alias} type="button" role="option" aria-selected={i === menuIndex} onClick={() => applyMention(m.alias)}>
              <b>@{m.alias}</b>
              <span>{m.note}</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className={ui.alert} role="alert">
          {error}
        </p>
      )}

      {tray === 'poll' && (
        <PollForm
          onClose={() => setTray(null)}
          onPost={(body) => {
            sendBody(body);
            setTray(null);
          }}
        />
      )}
      {tray === 'status' && (
        <div className={c.form} style={kind('quartz')}>
          <StatusForm pod={pod} onSaved={() => setTray(null)} />
        </div>
      )}
      {tray === 'format' && (
        <div className={c.format} role="toolbar" aria-label="Formatting">
          {FORMATS.map((f) => (
            <button key={f.name} type="button" onClick={() => wrap(f.before, f.after, f.text)}>
              {f.name}
            </button>
          ))}
        </div>
      )}

      {quote && (
        <div className={c.quoting} style={colorVar(quote.senderAlias)}>
          <p>
            <b>{quote.senderAlias}</b> {quote.body || 'sent a file'}
          </p>
          <button type="button" className={`${ui.icon} ${ui.glass}`} style={{ background: 'var(--glass)' }} onClick={() => setQuote(null)} aria-label="Drop the quote">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      )}

      {pending.length > 0 && (
        <div className={c.chips}>
          {pending.map((a) => (
            <span key={a.id} className={c.chip}>
              <span>{a.fileName}</span>
              <button
                type="button"
                aria-label={`Take out ${a.fileName}`}
                onClick={() => setPending((prev) => prev.filter((x) => x.id !== a.id))}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      {recording ? (
        <div className={c.record} role="status">
          <b>{seconds(recordElapsedMs / 1000)}</b>
          <span className={c.live} aria-hidden="true">
            {HUM.map((v, i) => (
              <i key={i} style={{ '--v': `${v}%` } as CSSProperties} />
            ))}
          </span>
          {recordingSynthFallback && <span>No microphone, sending a tone</span>}
          <button type="button" className={`${ui.btn} ${ui.glass}`} onClick={cancelVoiceNoteRecording}>
            Cancel
          </button>
          <button type="button" className={`${ui.btn} ${ui.ink}`} onClick={finishAndSendVoiceNote}>
            Send it
          </button>
        </div>
      ) : (
        <div className={c.kinds} role="group" aria-label="Add a piece">
          {inRoom && !proRoom && (
            <button type="button" style={kind('cobalt')} onClick={openVote}>
              Vote
            </button>
          )}
          {inRoom && (
            <button type="button" style={kind('mint')} aria-expanded={tray === 'poll'} onClick={() => toggleTray('poll')}>
              Poll
            </button>
          )}
          <button type="button" style={kind('coral')} disabled={uploading} onClick={startVoiceNoteRecording}>
            Voice note
          </button>
          {inRoom && (
            <button type="button" style={kind('amber')} disabled={sendMutation.isPending} onClick={() => sendBody('/icebreaker')}>
              Icebreaker
            </button>
          )}
          <button type="button" style={kind('quartz')} aria-expanded={tray === 'status'} onClick={() => toggleTray('status')}>
            Status
          </button>
          <button type="button" style={kind('birch')} disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? 'Uploading' : 'File'}
          </button>
          <button type="button" style={kind('slate')} aria-expanded={tray === 'format'} onClick={() => toggleTray('format')}>
            Format
          </button>
          <input ref={fileRef} type="file" hidden onChange={pickFile} />
        </div>
      )}

      <div className={c.write}>
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            emitTyping(e.target.value.trim().length > 0);
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className={`${ui.btn} ${ui.big} ${ui.blue}`}
          disabled={sendMutation.isPending || uploading || (!draft.trim() && pending.length === 0)}
          onClick={submit}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function PollForm({
  onPost,
  onClose,
}: {
  onPost: (body: string) => void;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState(['', '']);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parts = [question, ...answers].map((x) => x.trim()).filter(Boolean);
    if (!question.trim() || parts.length < 3) return;
    onPost(`/poll ${parts.map((x) => `"${x.replace(/"/g, "'")}"`).join(' ')}`);
  };
  const input = `${ui.input} ${ui.onColor}`;

  return (
    <form className={c.form} style={{ '--c': 'var(--c-mint)' } as CSSProperties} onSubmit={submit}>
      <div className={c.formHead}>
        <h3>Poll</h3>
        <button type="button" className={ui.icon} style={{ background: 'var(--glass)' }} onClick={onClose} aria-label="Close the poll">
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <input
        className={input}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Dumplings on Sunday: folded or pinched?"
        aria-label="Question"
        maxLength={240}
        required
        autoFocus
      />
      {answers.map((answer, i) => (
        <input
          key={i}
          className={input}
          value={answer}
          onChange={(e) => setAnswers(answers.map((x, k) => (k === i ? e.target.value : x)))}
          placeholder={`Answer ${i + 1}`}
          aria-label={`Answer ${i + 1}`}
          maxLength={80}
          required={i < 2}
        />
      ))}
      <div className={ui.row}>
        {answers.length < 5 && (
          <button type="button" className={`${ui.btn} ${ui.glass}`} onClick={() => setAnswers([...answers, ''])}>
            One more answer
          </button>
        )}
        <button type="submit" className={`${ui.btn} ${ui.ink}`}>
          Post poll
        </button>
      </div>
    </form>
  );
}

'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useAtomValue } from 'jotai';
import { colorVar } from '@/lib/pieces';
import { remoteSpeakingMapAtom, useVoiceActions } from '@/state/voiceEngine';
import { roomName, useOpenConversation, useRoomCall } from '@/state/roomActions';
import { Piece } from '@/components/pieces/Piece';
import type { PodDetail, PodMember } from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import s from '@/app/app/workspace.module.css';

const BARS = [40, 70, 55, 90, 60, 100, 48, 76, 36, 88, 64, 52, 96, 44, 80, 58, 72, 34, 86, 50, 66, 94, 42, 74];

function clock(totalSec: number): string {
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}

function listNames(names: string[]): string {
  const shown = names.length > 2 ? [...names.slice(0, 2), `${names.length - 2} more`] : names;
  return shown.length > 1
    ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
    : shown[0];
}

function useElapsed(sinceMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!sinceMs) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sinceMs]);
  return sinceMs ? Math.max(0, Math.floor((now - sinceMs) / 1000)) : 0;
}

function Wave({ on }: { on: boolean }) {
  return (
    <span className={s.wave} data-on={on ? '' : undefined} aria-hidden="true">
      {BARS.map((v, i) => (
        <i key={i} style={{ '--v': `${v}%` } as CSSProperties} />
      ))}
    </span>
  );
}

// A voice in the call. Pressing anyone but yourself opens their volume.
interface Voice {
  peerId: string;
  alias: string;
  self: boolean;
  speaking: boolean;
  muted: boolean;
}

function Voices({ voices }: { voices: Voice[] }) {
  const { peerVolumes, setPeerVolume } = useVoiceActions();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = voices.find((v) => v.peerId === openId && !v.self);
  const percent = open ? Math.round((peerVolumes[open.peerId] ?? 1) * 100) : 100;

  return (
    <>
      <div className={s.who}>
        {voices.map((v) =>
          v.self ? (
            <span key={v.peerId} title="You" data-muted={v.muted ? '' : undefined}>
              <Piece alias={v.alias} speaking={v.speaking} />
            </span>
          ) : (
            <button
              key={v.peerId}
              type="button"
              title={v.alias}
              data-muted={v.muted ? '' : undefined}
              aria-expanded={openId === v.peerId}
              aria-label={`${v.alias}${v.muted ? ', muted' : ''}${v.speaking ? ', speaking' : ''}. Change volume`}
              onClick={() => setOpenId((cur) => (cur === v.peerId ? null : v.peerId))}
            >
              <Piece alias={v.alias} speaking={v.speaking} />
            </button>
          )
        )}
      </div>
      {open && (
        <label className={s.volume}>
          <span>
            <span>{open.alias}</span>
            <span>{percent}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={150}
            step={5}
            value={percent}
            aria-label={`Volume of ${open.alias}`}
            onChange={(e) => setPeerVolume(open.peerId, Number(e.target.value) / 100)}
          />
        </label>
      )}
    </>
  );
}

function Controls({
  muted,
  deafened,
  tone,
  hangUpLabel,
  onHangUp,
}: {
  muted: boolean;
  deafened: boolean;
  tone: boolean;
  hangUpLabel: string;
  onHangUp: () => void;
}) {
  const { toggleMute, toggleDeafen, toggleTestTone } = useVoiceActions();
  return (
    <div className={s.callBtns}>
      <button type="button" aria-pressed={muted} onClick={toggleMute}>
        {muted ? 'Muted' : 'Mute'}
      </button>
      <button type="button" aria-pressed={deafened} onClick={toggleDeafen}>
        {deafened ? 'Deafened' : 'Deafen'}
      </button>
      <button type="button" aria-pressed={tone} onClick={toggleTestTone}>
        Test tone
      </button>
      <button type="button" className={s.stop} onClick={onHangUp}>
        {hangUpLabel}
      </button>
    </div>
  );
}

export function CallCard({
  pod,
  members,
}: {
  pod: PodDetail;
  members: PodMember[];
}) {
  const { session, dmSession, joinVoice, leaveVoice, endDmCall } = useVoiceActions();
  const speakingMap = useAtomValue(remoteSpeakingMapAtom);
  const { inCall, peers } = useRoomCall(pod);
  const elapsed = useElapsed(
    dmSession.status === 'connected' ? dmSession.connectedAtMs : null
  );

  // A private call takes the block over until it ends.
  if (dmSession.status !== 'idle' && dmSession.podId === pod.podId) {
    const connected = dmSession.status === 'connected';
    const peerSpeaking = Boolean(
      dmSession.peerSpeaking || (dmSession.peerId && speakingMap[dmSession.peerId])
    );
    return (
      <section className={s.call} aria-label={`Private call with ${dmSession.peerAlias}`}>
        <div className={s.callTop}>
          <b>
            {connected
              ? `Private call, ${dmSession.peerAlias}`
              : dmSession.status === 'connecting'
                ? `Connecting to ${dmSession.peerAlias}`
                : `Ringing ${dmSession.peerAlias}`}
          </b>
          {connected && <time>{clock(elapsed)}</time>}
        </div>
        {connected ? (
          <>
            <Wave on={peerSpeaking || dmSession.selfSpeaking} />
            <Voices
              voices={[
                {
                  peerId: pod.myPeerId,
                  alias: pod.myAlias,
                  self: true,
                  speaking: dmSession.selfSpeaking,
                  muted: dmSession.muted,
                },
                {
                  peerId: dmSession.peerId ?? '',
                  alias: dmSession.peerAlias,
                  self: false,
                  speaking: peerSpeaking,
                  muted: dmSession.peerMuted,
                },
              ]}
            />
            {dmSession.fallbackBanner && <p>{dmSession.fallbackBanner}</p>}
            <Controls
              muted={dmSession.muted}
              deafened={dmSession.deafened}
              tone={dmSession.testToneActive}
              hangUpLabel="Hang up"
              onHangUp={endDmCall}
            />
          </>
        ) : (
          <>
            <p>
              {dmSession.targetOnline
                ? 'Nobody else in the room hears it ring.'
                : `${dmSession.peerAlias} is away right now.`}
            </p>
            <div className={s.callBtns}>
              <button type="button" className={`${s.stop} ${s.span}`} onClick={endDmCall}>
                Cancel
              </button>
            </div>
          </>
        )}
      </section>
    );
  }

  const voices: Voice[] = peers.map((p) => {
    const self = p.peerId === pod.myPeerId;
    return {
      peerId: p.peerId,
      alias: p.alias,
      self,
      speaking: self
        ? session.selfSpeaking || p.speaking
        : Boolean(p.speaking || speakingMap[p.peerId]),
      muted: p.muted,
    };
  });
  const speaker = voices.find((v) => v.speaking);
  const join = () => joinVoice(pod.podId, roomName(pod));

  if (inCall) {
    return (
      <section className={s.call} aria-label="Room call">
        <div className={s.callTop}>
          <b>
            {session.status === 'connecting'
              ? 'Joining the call'
              : speaker
                ? `Room call, ${speaker.self ? 'you are' : `${speaker.alias} is`} speaking`
                : `Room call, ${voices.length} in it`}
          </b>
        </div>
        <Wave on={Boolean(speaker)} />
        <Voices voices={voices} />
        {session.fallbackBanner && <p>{session.fallbackBanner}</p>}
        <Controls
          muted={session.muted}
          deafened={session.deafened}
          tone={session.testToneActive}
          hangUpLabel="Leave call"
          onHangUp={leaveVoice}
        />
      </section>
    );
  }

  const online = members.filter((m) => m.online && m.peerId !== pod.myPeerId).length;
  return (
    <section className={s.call} aria-label="Room call">
      <div className={s.callTop}>
        <b>
          {voices.length > 0
            ? `${listNames(voices.map((v) => v.alias))} ${voices.length === 1 ? 'is' : 'are'} in the call`
            : 'Room call'}
        </b>
      </div>
      {voices.length > 0 ? (
        <div className={s.who}>
          {voices.slice(0, 10).map((v) => (
            <Piece key={v.peerId} alias={v.alias} speaking={v.speaking} />
          ))}
        </div>
      ) : (
        <p>
          {online > 0
            ? `Open and empty. ${online} ${online === 1 ? 'other is' : 'others are'} online.`
            : 'Open and empty.'}
        </p>
      )}
      <div className={s.callBtns}>
        <button type="button" className={`${s.go} ${s.span}`} onClick={join}>
          {voices.length > 0 ? 'Join the call' : 'Start the call'}
        </button>
      </div>
    </section>
  );
}

// Phones keep the call block on the People tab, so the chat gets one line of it.
export function CallStrip({ pod, inDm }: { pod: PodDetail; inDm: boolean }) {
  const { session, dmSession, joinVoice, leaveVoice, endDmCall, toggleMute } =
    useVoiceActions();
  const { inCall, peers } = useRoomCall(pod);
  const elapsed = useElapsed(
    dmSession.status === 'connected' ? dmSession.connectedAtMs : null
  );

  if (dmSession.status !== 'idle' && dmSession.podId === pod.podId) {
    const connected = dmSession.status === 'connected';
    return (
      <div className={s.strip} role="region" aria-label="Private call">
        <b>{connected ? `${dmSession.peerAlias} ${clock(elapsed)}` : `Ringing ${dmSession.peerAlias}`}</b>
        {connected && (
          <button type="button" aria-pressed={dmSession.muted} onClick={toggleMute}>
            {dmSession.muted ? 'Muted' : 'Mute'}
          </button>
        )}
        <button type="button" className={s.stop} onClick={endDmCall}>
          {connected ? 'Hang up' : 'Cancel'}
        </button>
      </div>
    );
  }
  if (inCall) {
    return (
      <div className={s.strip} role="region" aria-label="Room call">
        <b>{session.status === 'connecting' ? 'Joining' : `${peers.length} in the call`}</b>
        <button type="button" aria-pressed={session.muted} onClick={toggleMute}>
          {session.muted ? 'Muted' : 'Mute'}
        </button>
        <button type="button" className={s.stop} onClick={leaveVoice}>
          Leave
        </button>
      </div>
    );
  }
  // A private chat only shows a call you are already in.
  if (peers.length === 0 || inDm) return null;
  return (
    <div className={s.strip} role="region" aria-label="Room call">
      <b>{peers.length === 1 ? `${peers[0].alias} is in the call` : `${peers.length} in the call`}</b>
      <button
        type="button"
        className={s.go}
        onClick={() => joinVoice(pod.podId, roomName(pod))}
      >
        Join
      </button>
    </div>
  );
}

export function IncomingCall() {
  const { incomingDmCall: call, acceptDmCall, declineDmCall } = useVoiceActions();
  const openConversation = useOpenConversation();
  if (!call) return null;
  return (
    <div
      className={s.ring}
      style={colorVar(call.fromAlias)}
      role="alertdialog"
      aria-label={`${call.fromAlias} is calling you`}
    >
      <div>
        <b>{call.fromAlias} is calling you</b>
        <small>A private call. The room does not hear it ring.</small>
      </div>
      <button
        type="button"
        className={`${ui.btn} ${ui.glass}`}
        onClick={declineDmCall}
      >
        Decline
      </button>
      <button
        type="button"
        className={`${ui.btn} ${ui.ink}`}
        onClick={() => {
          openConversation(call.podId, call.fromPeerId);
          acceptDmCall();
        }}
      >
        Answer
      </button>
    </div>
  );
}

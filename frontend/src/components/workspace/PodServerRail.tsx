'use client';

import React, { useMemo } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  Bookmark,
  Compass,
  Plus,
  Search,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import {
  accountDrawerOpenAtom,
  activePodIdAtom,
  commandModalOpenAtom,
  interestModalOpenAtom,
  interestModalTabAtom,
  mobileNavOpenAtom,
  rightPanelAtom,
  voicePeersByPodAtom,
} from '@/state/workspaceAtoms';
import { voiceSessionAtom } from '@/state/voiceEngine';
import { getPodTierLabel, type PodDetail } from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

function podMonogram(pod: PodDetail): string {
  const clean = (pod.title || pod.interestLabel || pod.code || 'PD')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase() || 'PD';
}

function podShortCode(pod: PodDetail): string {
  const digits = pod.code.replace(/\D/g, '');
  return digits.slice(-2) || pod.code.slice(-2);
}

export function PodServerRail({ pods }: { pods: PodDetail[] }) {
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const [rightPanel, setRightPanel] = useAtom(rightPanelAtom);
  const setInterestOpen = useSetAtom(interestModalOpenAtom);
  const setInterestTab = useSetAtom(interestModalTabAtom);
  const setCommandOpen = useSetAtom(commandModalOpenAtom);
  const setAccountOpen = useSetAtom(accountDrawerOpenAtom);
  const setMobileNavOpen = useSetAtom(mobileNavOpenAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);
  const voiceSession = useAtomValue(voiceSessionAtom);

  const interestCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of pods) {
      map.set(p.interestSlug, (map.get(p.interestSlug) || 0) + 1);
    }
    return map;
  }, [pods]);

  const hasLiveVoice = (pod: PodDetail): boolean => {
    if (voiceSession.status === 'connected' && voiceSession.podId === pod.podId) {
      return true;
    }
    const peers = voicePeersByPod[pod.podId];
    if (peers && peers.length > 0) {
      return true;
    }
    return pod.members.some((m) => Boolean(m.inVoice));
  };

  return (
    <nav className={styles.serverRail} aria-label="Matched interest pods">
      <button
        type="button"
        className={styles.railHomeBtn}
        onClick={() => {
          setInterestTab(pods.length > 0 ? 'pods' : 'match');
          setInterestOpen(true);
          setMobileNavOpen(false);
        }}
        title={
          pods.length > 0
            ? `My Active Pods (${pods.length}) & Switcher`
            : 'Canopy Workspace'
        }
        aria-label="My Active Pods and Workspace Switcher"
      >
        C
      </button>

      <div className={styles.railDivider} role="separator" />

      <div className={styles.railPodsList}>
        {pods.map((pod) => {
          const isActive = pod.podId === activePodId;
          const voiceLive = hasLiveVoice(pod);
          const hasMultipleSameInterest =
            (interestCounts.get(pod.interestSlug) || 0) > 1;
          const tier = getPodTierLabel(pod.maxMembers);

          return (
            <div key={pod.podId} className={styles.railPodWrap}>
              {isActive && (
                <span className={styles.railActiveBar} aria-hidden="true" />
              )}
              <button
                type="button"
                className={`${styles.railPodBtn} ${
                  isActive ? styles.railPodBtnActive : ''
                }`}
                onClick={() => {
                  setActivePodId(pod.podId);
                  setMobileNavOpen(false);
                }}
                title={`${pod.title ? `${pod.title} (#${pod.code})` : `#${pod.code}`} · ${pod.interestLabel} (${pod.memberCount}/${pod.maxMembers} · ${tier})`}
                aria-label={`Pod ${pod.title || `#${pod.code}`} (${pod.interestLabel}, ${pod.memberCount}/${pod.maxMembers} ${tier})`}
                aria-current={isActive ? 'true' : undefined}
              >
                <span>{podMonogram(pod)}</span>
                {hasMultipleSameInterest && (
                  <span className={styles.railSubCode} aria-hidden="true">
                    {podShortCode(pod)}
                  </span>
                )}
                {voiceLive && (
                  <span
                    className={styles.railVoiceDot}
                    title="Pod audio call active"
                    aria-label="Pod audio call active"
                  />
                )}
              </button>
            </div>
          );
        })}

        <button
          type="button"
          className={styles.railUtilBtn}
          onClick={() => {
            setInterestTab('match');
            setInterestOpen(true);
            setMobileNavOpen(false);
          }}
          title="+ Match or Create Pod"
          aria-label="Match Interests or Create Pod"
        >
          {pods.length === 0 ? <Compass size={19} /> : <Plus size={19} />}
        </button>
      </div>

      <div className={styles.railDivider} role="separator" />

      <button
        type="button"
        className={`${styles.railUtilBtn} ${
          rightPanel === 'bookmarks' ? styles.railUtilBtnActive : ''
        }`}
        onClick={() => {
          setRightPanel(rightPanel === 'bookmarks' ? null : 'bookmarks');
          setMobileNavOpen(false);
        }}
        title="Saved Bookmarks"
        aria-label="Saved Bookmarks"
      >
        <Bookmark size={18} />
      </button>

      <button
        type="button"
        className={styles.railUtilBtn}
        onClick={() => {
          setCommandOpen(true);
          setMobileNavOpen(false);
        }}
        title="Search chats, members & messages (Cmd+K)"
        aria-label="Quick Switcher & Search (Cmd+K)"
      >
        <Search size={18} />
      </button>

      <button
        type="button"
        className={styles.railUtilBtn}
        onClick={() => {
          window.open('/register?fresh=1', '_blank', 'noopener');
        }}
        title="+ Open 2nd Account Tab (/register?fresh=1)"
        aria-label="Open 2nd Account Tab"
      >
        <UserPlus size={18} />
      </button>

      <button
        type="button"
        className={styles.railAvatarBtn}
        onClick={() => {
          setAccountOpen(true);
          setMobileNavOpen(false);
        }}
        title="My Private Account (Hidden from rooms)"
        aria-label="My Private Account"
      >
        <ShieldCheck size={19} />
      </button>
    </nav>
  );
}

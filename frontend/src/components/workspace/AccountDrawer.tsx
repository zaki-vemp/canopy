'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { Crown, ExternalLink, Lock, LogOut, Plus, Scale, X } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { authRevisionAtom, performLogout } from '@/state/authAtoms';
import {
  accountDrawerOpenAtom,
  activePodIdAtom,
  interestModalOpenAtom,
  interestModalTabAtom,
  presenceByPodAtom,
  typingByConvoAtom,
  unreadByConvoAtom,
  voicePeersByPodAtom,
} from '@/state/workspaceAtoms';
import { useVoiceActions } from '@/state/voiceEngine';
import type { PlanTier, SelfUser } from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

export function AccountDrawer({ user }: { user: SelfUser }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useAtom(accountDrawerOpenAtom);
  const authRevision = useAtomValue(authRevisionAtom);
  const bumpAuthRevision = useSetAtom(authRevisionAtom);
  const setActivePodId = useSetAtom(activePodIdAtom);
  const setInterestOpen = useSetAtom(interestModalOpenAtom);
  const setInterestTab = useSetAtom(interestModalTabAtom);
  const setPresenceByPod = useSetAtom(presenceByPodAtom);
  const setVoicePeersByPod = useSetAtom(voicePeersByPodAtom);
  const setTypingByConvo = useSetAtom(typingByConvoAtom);
  const setUnreadByConvo = useSetAtom(unreadByConvoAtom);
  const { leaveVoice } = useVoiceActions();

  const [fullName, setFullName] = useState(user.fullName);
  const [gender, setGender] = useState(user.gender);
  const [nationalityCode, setNationalityCode] = useState(user.nationalityCode);
  const [savedNotice, setSavedNotice] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  useEffect(() => {
    setFullName(user.fullName);
    setGender(user.gender);
    setNationalityCode(user.nationalityCode);
  }, [user]);

  const updateProfileMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ user: SelfUser }>('/api/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({
          fullName: fullName.trim(),
          gender: gender.trim(),
          nationalityCode: nationalityCode.trim().toUpperCase(),
        }),
      }),
    onSuccess: (res) => {
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 1800);
      queryClient.setQueryData(['auth', 'me', authRevision], res);
      bumpAuthRevision((r) => r + 1);
    },
  });

  const switchPlanMutation = useMutation({
    mutationFn: (planTier: PlanTier) =>
      apiFetch<{ user: SelfUser }>('/api/auth/plan', {
        method: 'POST',
        body: JSON.stringify({ planTier }),
      }),
    onSuccess: (res) => {
      setPlanError(null);
      queryClient.setQueryData(['auth', 'me', authRevision], res);
      bumpAuthRevision((r) => r + 1);
    },
    onError: (err: Error) => {
      setPlanError(err.message || 'Could not update plan tier');
    },
  });

  if (!open) return null;

  const isPro = user.planTier === 'PREMIUM';

  const handleLogout = async () => {
    leaveVoice();
    await performLogout();
    queryClient.clear();
    setActivePodId(null);
    setPresenceByPod({});
    setVoicePeersByPod({});
    setTypingByConvo({});
    setUnreadByConvo({});
    setOpen(false);
    router.replace('/login');
  };

  return (
    <div
      className={styles.modalOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="private-account-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className={styles.modalCard} style={{ maxWidth: 510 }}>
        <div className={styles.modalHeader}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2
                id="private-account-title"
                style={{ margin: 0, fontSize: 18 }}
              >
                My Account
              </h2>
              {isPro && <span className={styles.proBadge}>CANOPY PRO</span>}
            </div>
            <div
              style={{
                marginTop: 6,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 999,
                background: '#eafbef',
                border: '1px solid rgba(31,107,58,0.28)',
                color: '#164e2a',
                fontFamily: 'var(--m-font-mono)',
                fontSize: 11.5,
                fontWeight: 600,
              }}
            >
              <Lock size={12} />
              <span>Private to you · Hidden from all rooms</span>
            </div>
          </div>

          <button
            type="button"
            className={styles.composerIconBtn}
            onClick={() => setOpen(false)}
            aria-label="Close account drawer"
          >
            <X size={18} />
          </button>
        </div>

        <div
          className={styles.modalBody}
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          {/* Plan Switcher Card */}
          <div className={styles.planSwitcherCard}>
            <div className={styles.planSwitcherTop}>
              <span
                className={
                  isPro ? styles.govModePillAdmin : styles.govModePillDemocratic
                }
              >
                {isPro ? <Crown size={12} /> : <Scale size={12} />}
                <span>
                  {isPro
                    ? 'Canopy Pro — Custom Admin & Publicized Groups'
                    : 'Free Plan — Democratic 25-Seat Pods'}
                </span>
              </span>
            </div>

            <p style={{ margin: '6px 0 10px', fontSize: 12.5, color: '#4d4d4d' }}>
              {isPro
                ? 'Create your own private invite-only or publicized directory groups with custom #handles, 10/25/50 seats, and instant Owner/Admin controls.'
                : 'Match into 25-member democratic pods run by YES/NO votes, or upgrade to Canopy Pro to launch custom private & publicized admin groups.'}
            </p>

            {planError && (
              <div
                style={{
                  marginBottom: 8,
                  padding: '6px 9px',
                  borderRadius: 7,
                  background: '#fef3f2',
                  color: '#b42318',
                  fontSize: 12,
                }}
                role="alert"
              >
                {planError}
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                disabled={switchPlanMutation.isPending}
                onClick={() =>
                  switchPlanMutation.mutate(isPro ? 'FREE' : 'PREMIUM')
                }
                className={
                  isPro ? styles.secondaryActionBtn : styles.primaryActionBtn
                }
              >
                <Crown size={15} />
                <span>
                  {switchPlanMutation.isPending
                    ? 'Updating Plan...'
                    : isPro
                      ? 'Switch to Free'
                      : 'Upgrade to Canopy Pro'}
                </span>
              </button>

              {isPro && (
                <button
                  type="button"
                  className={styles.primaryActionBtn}
                  onClick={() => {
                    setOpen(false);
                    setInterestTab('custom');
                    setInterestOpen(true);
                  }}
                >
                  <Plus size={15} />
                  <span>Create Own Pod</span>
                </button>
              )}
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              updateProfileMutation.mutate();
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#686868',
                  marginBottom: 4,
                }}
              >
                Email (Authentication only)
              </label>
              <input
                type="email"
                value={user.email}
                disabled
                className={styles.statusInput}
                style={{
                  width: '100%',
                  height: 44,
                  fontSize: 16,
                  opacity: 0.75,
                }}
              />
            </div>

            <div>
              <label
                htmlFor="acct-fullname"
                style={{
                  display: 'block',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#686868',
                  marginBottom: 4,
                }}
              >
                Full Name (Never shared in pods)
              </label>
              <input
                id="acct-fullname"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className={styles.statusInput}
                style={{ width: '100%', height: 44, fontSize: 16 }}
              />
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 120px',
                gap: 10,
              }}
            >
              <div>
                <label
                  htmlFor="acct-gender"
                  style={{
                    display: 'block',
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#686868',
                    marginBottom: 4,
                  }}
                >
                  Gender (Private)
                </label>
                <input
                  id="acct-gender"
                  type="text"
                  value={gender}
                  onChange={(e) => setGender(e.target.value)}
                  required
                  className={styles.statusInput}
                  style={{ width: '100%', height: 44, fontSize: 16 }}
                />
              </div>

              <div>
                <label
                  htmlFor="acct-nat"
                  style={{
                    display: 'block',
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#686868',
                    marginBottom: 4,
                  }}
                >
                  Country ISO-2
                </label>
                <input
                  id="acct-nat"
                  type="text"
                  maxLength={2}
                  value={nationalityCode}
                  onChange={(e) =>
                    setNationalityCode(e.target.value.toUpperCase())
                  }
                  required
                  className={styles.statusInput}
                  style={{
                    width: '100%',
                    height: 44,
                    fontSize: 16,
                    fontFamily: 'var(--m-font-mono)',
                  }}
                />
              </div>
            </div>

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                marginTop: 4,
              }}
            >
              <button
                type="submit"
                className={styles.primaryActionBtn}
                disabled={updateProfileMutation.isPending}
              >
                {savedNotice
                  ? 'Saved Private Profile'
                  : 'Save Private Profile'}
              </button>

              <button
                type="button"
                className={styles.secondaryActionBtn}
                onClick={() => {
                  window.open('/register?fresh=1', '_blank', 'noopener');
                }}
              >
                <ExternalLink size={15} />
                <span>+ Open 2nd Account Tab</span>
              </button>
            </div>
          </form>
        </div>

        <div className={styles.modalFooter}>
          <span style={{ fontSize: 12, color: '#686868' }}>
            Multi-tab isolated sessions supported via /register?fresh=1
          </span>
          <button
            type="button"
            className={styles.leaveBtn}
            onClick={handleLogout}
          >
            <LogOut size={15} />
            <span>Log out</span>
          </button>
        </div>
      </div>
    </div>
  );
}

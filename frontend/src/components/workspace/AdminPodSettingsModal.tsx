'use client';

import React, { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAtom } from 'jotai';
import { Crown, Globe, Lock, X } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { adminSettingsPodIdAtom } from '@/state/workspaceAtoms';
import type { PodDetail, UpdatePodSettingsRequest } from '@/types/canopy';
import styles from '@/app/app/workspace.module.css';

export function AdminPodSettingsModal({ pods }: { pods: PodDetail[] }) {
  const queryClient = useQueryClient();
  const [podId, setPodId] = useAtom(adminSettingsPodIdAtom);

  const pod = pods.find((p) => p.podId === podId) ?? null;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [maxMembers, setMaxMembers] = useState<10 | 25 | 50>(25);
  const [isPublicized, setIsPublicized] = useState(false);
  const [isOpen, setIsOpen] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!pod) {
      setErrorMsg(null);
      setSavedMsg(null);
      return;
    }
    setTitle(pod.title || '');
    setDescription(pod.description || '');
    const normalizedCap: 10 | 25 | 50 =
      pod.maxMembers <= 10 ? 10 : pod.maxMembers <= 25 ? 25 : 50;
    setMaxMembers(normalizedCap);
    setIsPublicized(Boolean(pod.isPublicized));
    setIsOpen(pod.isOpen !== false);
    setErrorMsg(null);
    setSavedMsg(null);
  }, [pod?.podId]);

  const updateSettingsMutation = useMutation({
    mutationFn: (payload: UpdatePodSettingsRequest) => {
      if (!pod) throw new Error('No group selected');
      return apiFetch<{ pod: PodDetail }>(`/api/pods/${pod.podId}/settings`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (res) => {
      setErrorMsg(null);
      setSavedMsg('Group settings saved.');
      setTimeout(() => setSavedMsg(null), 2000);
      queryClient.setQueryData<{ pods: PodDetail[] }>(['pods'], (old) =>
        old
          ? {
              pods: old.pods.map((p) =>
                p.podId === res.pod.podId
                  ? {
                      ...p,
                      ...res.pod,
                      dmConversations:
                        res.pod.dmConversations && res.pod.dmConversations.length > 0
                          ? res.pod.dmConversations
                          : p.dmConversations,
                    }
                  : p
              ),
            }
          : { pods: [res.pod] }
      );
      queryClient.invalidateQueries({ queryKey: ['publicized-pods'] });
    },
    onError: (err: Error) => {
      setErrorMsg(err.message || 'Could not update group settings');
    },
  });

  if (!podId || !pod) return null;

  return (
    <div
      className={`${styles.modalOverlay} ${styles.inviteModalOverlay}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-pod-settings-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) setPodId(null);
      }}
    >
      <div className={styles.modalCard} style={{ maxWidth: 560 }}>
        <div className={styles.modalHeader}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Crown size={18} color="#164e2a" />
              <h2
                id="admin-pod-settings-title"
                style={{ margin: 0, fontSize: 18 }}
              >
                Manage Group · #{pod.code}
              </h2>
            </div>
            <p style={{ margin: '3px 0 0', fontSize: 12.5, color: '#686868' }}>
              Instant Owner/Admin settings — update group title, directory
              publicity, seat cap, or member joins.
            </p>
          </div>
          <button
            type="button"
            className={styles.composerIconBtn}
            onClick={() => setPodId(null)}
            aria-label="Close group settings"
          >
            <X size={18} />
          </button>
        </div>

        <form
          className={styles.modalBody}
          onSubmit={(e) => {
            e.preventDefault();
            updateSettingsMutation.mutate({
              title: title.trim(),
              description: description.trim(),
              maxMembers,
              isPublicized,
              isOpen,
            });
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          {errorMsg && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: '#fef3f2',
                color: '#b42318',
                fontSize: 13,
              }}
              role="alert"
            >
              {errorMsg}
            </div>
          )}

          {savedMsg && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                background: '#eafbef',
                border: '1px solid rgba(31,107,58,0.28)',
                color: '#154726',
                fontSize: 13,
                fontWeight: 600,
              }}
              role="status"
            >
              {savedMsg}
            </div>
          )}

          <div className={styles.inviteFieldGroup}>
            <label
              htmlFor="admin-group-title"
              className={styles.podOptionLabel}
            >
              Group Title
            </label>
            <input
              id="admin-group-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Tactical Co-op Raiders"
              maxLength={80}
              required
              className={styles.statusInput}
              style={{ height: 44, fontSize: 15 }}
            />
          </div>

          <div className={styles.inviteFieldGroup}>
            <label htmlFor="admin-group-desc" className={styles.podOptionLabel}>
              Description
            </label>
            <input
              id="admin-group-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this group about?"
              maxLength={240}
              className={styles.statusInput}
              style={{ height: 44, fontSize: 14.5 }}
            />
          </div>

          <div className={styles.inviteFieldGroup}>
            <span className={styles.podOptionLabel}>Max Seats</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {([10, 25, 50] as const).map((cap) => (
                <button
                  key={cap}
                  type="button"
                  onClick={() => setMaxMembers(cap)}
                  aria-pressed={maxMembers === cap}
                  className={`${styles.podOptionPill} ${
                    maxMembers === cap ? styles.podOptionPillActive : ''
                  }`}
                  style={{ flex: 1, minHeight: 44 }}
                >
                  {cap === 10
                    ? 'Compact (10)'
                    : cap === 25
                      ? 'Standard (25)'
                      : 'Club (50)'}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.inviteFieldGroup}>
            <span className={styles.podOptionLabel}>Group Visibility</span>
            <div className={styles.visibilityGrid}>
              <button
                type="button"
                onClick={() => setIsPublicized(false)}
                aria-pressed={!isPublicized}
                className={`${styles.visibilityChoiceCard} ${
                  !isPublicized ? styles.visibilityChoiceCardActive : ''
                }`}
              >
                <div className={styles.visibilityChoiceHead}>
                  <Lock size={15} />
                  <strong>Keep Private (Invite-Only)</strong>
                </div>
                <span>
                  Hidden from directory — only peers with your /invite link can
                  join.
                </span>
              </button>

              <button
                type="button"
                onClick={() => setIsPublicized(true)}
                aria-pressed={isPublicized}
                className={`${styles.visibilityChoiceCard} ${
                  isPublicized ? styles.visibilityChoiceCardActive : ''
                }`}
              >
                <div className={styles.visibilityChoiceHead}>
                  <Globe size={15} />
                  <strong>Publicize in Directory</strong>
                </div>
                <span>
                  Featured in Publicized Groups so anyone can discover and join.
                </span>
              </button>
            </div>
          </div>

          <div className={styles.inviteFieldGroup}>
            <span className={styles.podOptionLabel}>New Member Joins</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => setIsOpen(true)}
                aria-pressed={isOpen}
                className={`${styles.podOptionPill} ${
                  isOpen ? styles.podOptionPillActive : ''
                }`}
                style={{ flex: 1, minHeight: 44 }}
              >
                Open to Joins
              </button>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-pressed={!isOpen}
                className={`${styles.podOptionPill} ${
                  !isOpen ? styles.podOptionPillActive : ''
                }`}
                style={{ flex: 1, minHeight: 44 }}
              >
                Closed / Paused
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={updateSettingsMutation.isPending}
            className={styles.primaryActionBtn}
          >
            {updateSettingsMutation.isPending
              ? 'Saving Settings...'
              : 'Save Group Settings'}
          </button>
        </form>
      </div>
    </div>
  );
}

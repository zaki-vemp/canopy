import React, { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '../theme/ui';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  adminKickMember,
  adminUpdateMemberRole,
  createPodProposal,
  fetchPods,
  updatePodStatus,
} from '../api/client';
import {
  activePodIdAtom,
  activeTabAtom,
  activeDmCallAtom,
  activeDmPeerByPodAtom,
  activeVoiceSessionAtom,
  callLinksAtom,
  callNoticeAtom,
  voicePeersByPodAtom,
  wsConnectedAtom,
} from '../state/atoms';
import type { PodDetailDto, VoicePeerDto } from '../types/canopy';
import {
  GUTTER,
  INSET,
  PIECES,
  PIECE_HEX,
  TOUCH_MIN,
  capacityTierBadge,
  pieceColor,
} from '../theme/palette';
import { Badge, Btn, Chip, Piece, fieldStyles } from '../components/Pieces';
import { CallBar } from '../components/CallBar';
import type { Calls } from '../voice/useCalls';

const MONO_FONT = 'DMMono_500Medium';

const SEAT = 52;
const SEAT_GAP_MIN = 8;

export function VoiceLoungeScreen({
  calls,
  phone = false,
  otherRoomsUnread = 0,
}: {
  calls: Calls;
  phone?: boolean;
  otherRoomsUnread?: number;
}) {
  const [activePodId, setActivePodId] = useAtom(activePodIdAtom);
  const setActiveTab = useSetAtom(activeTabAtom);
  const voiceSession = useAtomValue(activeVoiceSessionAtom);
  const voicePeersByPod = useAtomValue(voicePeersByPodAtom);
  const wsConnected = useAtomValue(wsConnectedAtom);
  const links = useAtomValue(callLinksAtom);
  const callNotice = useAtomValue(callNoticeAtom);
  const queryClient = useQueryClient();
  const setActiveDmPeerMap = useSetAtom(activeDmPeerByPodAtom);
  const activeDmCall = useAtomValue(activeDmCallAtom);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [memberNotice, setMemberNotice] = useState<string | null>(null);
  const [asList, setAsList] = useState(false);
  const [statusDraft, setStatusDraft] = useState('');

  const [seatGap, setSeatGap] = useState(SEAT_GAP_MIN);

  const podsQuery = useQuery({
    queryKey: ['pods'],
    queryFn: fetchPods,
  });

  const pods = podsQuery.data?.pods ?? [];
  const activePod: PodDetailDto | null = useMemo(() => {
    if (pods.length === 0) return null;
    return pods.find((p) => p.podId === activePodId) ?? pods[0];
  }, [pods, activePodId]);

  useEffect(() => {
    if (activePod && activePod.podId !== activePodId) {
      setActivePodId(activePod.podId);
    }
  }, [activePod, activePodId, setActivePodId]);

  useEffect(() => {
    setStatusDraft(activePod?.myStatus ?? '');
  }, [activePod?.podId, activePod?.myStatus]);

  const statusMutation = useMutation({
    mutationFn: (status: string) =>
      updatePodStatus(activePod?.podId ?? '', status),
    onSuccess: () => {
      setMemberNotice('Status updated.');
      queryClient.invalidateQueries({ queryKey: ['pods'] });
    },
    onError: (err) => {
      setMemberNotice(
        err instanceof Error ? err.message : 'Could not update your status.'
      );
    },
  });

  const adminKickMutation = useMutation({
    mutationFn: (targetPeerId: string) =>
      adminKickMember(activePod?.podId ?? '', targetPeerId),
    onSuccess: () => {
      setSelectedPeerId(null);
      setMemberNotice('Removed from group.');
      queryClient.invalidateQueries({ queryKey: ['pods'] });
    },
    onError: (err) => {
      setMemberNotice(err instanceof Error ? err.message : 'Could not remove them.');
    },
  });

  const adminRoleMutation = useMutation({
    mutationFn: ({ targetPeerId, role }: { targetPeerId: string; role: 'ADMIN' | 'MEMBER' }) =>
      adminUpdateMemberRole(activePod?.podId ?? '', targetPeerId, role),
    onSuccess: () => {
      setMemberNotice('Updated role.');
      queryClient.invalidateQueries({ queryKey: ['pods'] });
    },
    onError: (err) => {
      setMemberNotice(err instanceof Error ? err.message : 'Could not update role.');
    },
  });

  if (!activePod) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyTitle}>No room yet</Text>
        <Text style={styles.emptySub}>
          Join a room first. Its people and its call show up here.
        </Text>
        <Btn label="Go to Rooms" kind="blue" big onPress={() => setActiveTab('pods')} />
      </View>
    );
  }

  const activeSessionInThisPod =
    voiceSession && voiceSession.podId === activePod.podId
      ? voiceSession
      : null;

  const connectedPeers: VoicePeerDto[] = (() => {
    const wsPeers = voicePeersByPod[activePod.podId];
    const base: VoicePeerDto[] =
      wsPeers && wsPeers.length > 0
        ? [...wsPeers]
        : activePod.members
            .filter((m) => m.inVoice)
            .map((m) => ({
              peerId: m.peerId,
              alias: m.alias,
              color: m.color,
              muted: false,
              deafened: false,
              speaking: false,
            }));

    if (
      activeSessionInThisPod &&
      !base.some((p) => p.peerId === activePod.myPeerId)
    ) {
      base.push({
        peerId: activePod.myPeerId,
        alias: activePod.myAlias,
        color: activePod.myColor,
        muted: activeSessionInThisPod.muted,
        deafened: activeSessionInThisPod.deafened,
        speaking: activeSessionInThisPod.speaking,
      });
    }
    return base;
  })();

  const roomName = activePod.title?.trim() || activePod.interestLabel;
  const members = activePod.members;
  const freeSeats = Math.max(0, activePod.maxMembers - members.length);
  const selected =
    members.find((m) => m.peerId === selectedPeerId) ?? null;

  const openWrite = (peerId: string) => {
    setActiveDmPeerMap((prev) => ({ ...prev, [activePod.podId]: peerId }));
    setActiveTab('chat');
  };

  const startPrivateCall = (peerId: string, alias: string, online: boolean) => {
    openWrite(peerId);
    calls.startPrivateCall(activePod, {
      peerId,
      alias,
      color: pieceColor(alias),
      online,
    });
  };

  const voteToRemove = async (peerId: string, alias: string) => {
    try {
      await createPodProposal(activePod.podId, {
        kind: 'KICK_MEMBER',
        targetPeerId: peerId,
      });
      setMemberNotice(`A vote to remove ${alias} is open. Find it in Votes.`);
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      queryClient.invalidateQueries({ queryKey: ['proposals', activePod.podId] });
    } catch (err) {
      setMemberNotice(err instanceof Error ? err.message : 'Could not open that vote.');
    }
  };

  const namesInCall = connectedPeers.map((p) => p.alias);
  const callTitle =
    namesInCall.length === 0
      ? 'Nobody is in the call'
      : namesInCall.length === 1
      ? `${namesInCall[0]} is in the call`
      : namesInCall.length === 2
      ? `${namesInCall[0]} and ${namesInCall[1]} are in the call`
      : `${namesInCall.length} are in the call`;

  const isProRoom = activePod.governanceMode === 'ADMIN';
  const canAdminManage =
    isProRoom && (activePod.myRole === 'OWNER' || activePod.myRole === 'ADMIN');

  return (
    <View style={styles.container}>
      {phone ? (
        <>
          <View style={styles.phoneBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Back to Rooms${
                otherRoomsUnread > 0 ? `, ${otherRoomsUnread} unread in other rooms` : ''
              }`}
              onPress={() => setActiveTab('pods')}
              style={styles.roundBtn}
            >
              <Ionicons name="chevron-back" size={22} color={PIECES.ink} />
              {otherRoomsUnread > 0 ? (
                <View style={styles.cornerBadge}>
                  <Badge n={otherRoomsUnread} />
                </View>
              ) : null}
            </Pressable>
            <View style={styles.flex1}>
              <Text style={styles.phoneRoomName} numberOfLines={1}>
                {roomName}
              </Text>
              <Text style={styles.roomMeta} numberOfLines={1}>
                You are {activePod.myAlias} ·{' '}
                {capacityTierBadge(activePod.memberCount, activePod.maxMembers)}
              </Text>
            </View>
            <View
              style={[
                styles.wsDot,
                { backgroundColor: wsConnected ? PIECE_HEX.jade : PIECES.off },
              ]}
              accessibilityLabel={wsConnected ? 'Live' : 'Reconnecting'}
            />
          </View>
          <CallBar calls={calls} />
        </>
      ) : null}

    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Which room's people (wide layout) */}
      {!phone ? (
        <View style={styles.headRow}>
          <View style={styles.flex1}>
            <Text style={styles.roomName} numberOfLines={1}>
              {roomName}
            </Text>
            <Text style={styles.roomMeta}>
              You are {activePod.myAlias} ·{' '}
              {capacityTierBadge(activePod.memberCount, activePod.maxMembers)}
            </Text>
          </View>
          <View
            style={[
              styles.wsDot,
              { backgroundColor: wsConnected ? PIECE_HEX.jade : PIECES.off },
            ]}
            accessibilityLabel={wsConnected ? 'Live' : 'Reconnecting'}
          />
        </View>
      ) : null}

      {!phone && pods.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsRow}
        >
          {pods.map((p) => (
            <Chip
              key={p.podId}
              label={p.title?.trim() || p.interestLabel}
              active={p.podId === activePod.podId}
              onPress={() => {
                setSelectedPeerId(null);
                setActivePodId(p.podId);
              }}
            />
          ))}
        </ScrollView>
      ) : null}

      {/* The room call: one ink card */}
      <View style={styles.callCard}>
        <Text style={styles.callTitle}>{callTitle}</Text>
        {connectedPeers.length > 0 ? (
          <View style={styles.callPeers}>
            {connectedPeers.map((peer) => {
              const isSelf = peer.peerId === activePod.myPeerId;
              const speaking =
                isSelf && activeSessionInThisPod
                  ? activeSessionInThisPod.speaking
                  : peer.speaking;
              const muted =
                isSelf && activeSessionInThisPod
                  ? activeSessionInThisPod.muted
                  : peer.muted;
              const link = isSelf || !activeSessionInThisPod ? 'connected' : links[peer.peerId];
              const state =
                link === 'failed'
                  ? 'No sound'
                  : link !== 'connected'
                  ? 'Connecting'
                  : speaking
                  ? 'Speaking'
                  : muted
                  ? 'Muted'
                  : 'Listening';
              return (
                <View
                  key={peer.peerId}
                  accessible
                  accessibilityLabel={`${peer.alias}${isSelf ? ', you' : ''}, ${state}`}
                  style={styles.callPeer}
                >
                  <View style={styles.callPiece}>
                    <Piece alias={peer.alias} size={44} speaking={speaking} />
                  </View>
                  <Text style={styles.callPeerState}>{state}</Text>
                </View>
              );
            })}
          </View>
        ) : (
          <Text style={styles.callSub}>
            Drop in whenever you like. Others see only your alias.
          </Text>
        )}

        {callNotice ? <Text style={styles.callSub}>{callNotice}</Text> : null}

        {!activeSessionInThisPod ? (
          <Btn
            label={connectedPeers.length > 0 ? 'Join the call' : 'Start the call'}
            kind="blue"
            big
            wide
            disabled={!!activeDmCall}
            onPress={() => calls.joinRoomCall(activePod)}
            a11yLabel={`Join the call in ${roomName}`}
          />
        ) : (
          <View style={styles.controls}>
            <Btn
              label={activeSessionInThisPod.deafened ? 'Hear everyone' : 'Deafen'}
              kind="white"
              icon={activeSessionInThisPod.deafened ? 'volume-mute' : 'volume-high'}
              onPress={calls.toggleDeafen}
              a11yLabel={
                activeSessionInThisPod.deafened ? 'Undeafen audio' : 'Deafen audio'
              }
              style={styles.control}
            />
            <Btn
              label="Leave"
              kind="off"
              onPress={calls.hangUp}
              a11yLabel="Leave the call"
              style={styles.control}
            />
          </View>
        )}
      </View>

      {/* Everyone in the room: one piece each, or a readable list */}
      <View style={styles.sheetCard}>
        <View style={styles.seatsHead}>
          <Text style={styles.h3}>
            {members.length} of {activePod.maxMembers} seats
          </Text>
          <Chip
            label={asList ? 'Seats' : 'Names'}
            active={asList}
            onPress={() => setAsList((v) => !v)}
          />
        </View>
        {asList ? (
          <View style={styles.listCol}>
            {members.map((m) => {
              const on = m.peerId === selectedPeerId;
              return (
                <Pressable
                  key={m.peerId}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  onPress={() => {
                    setSelectedPeerId(on ? null : m.peerId);
                    setMemberNotice(null);
                  }}
                  style={[
                    styles.memberListRow,
                    on && { backgroundColor: pieceColor(m.alias) },
                  ]}
                >
                  <Piece alias={m.alias} size={44} away={!m.online} />
                  <View style={styles.flex1}>
                    <Text style={styles.memberListName} numberOfLines={1}>
                      {m.alias}
                      {m.isSelf || m.peerId === activePod.myPeerId ? ' (you)' : ''}
                    </Text>
                    <Text style={styles.memberListMeta} numberOfLines={1}>
                      {m.inVoice ? 'In the call' : m.online ? 'Online' : 'Away'}
                      {m.customStatus ? ` · ${m.customStatus}` : ''}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : (
        <View
          style={[styles.grid, { columnGap: seatGap }]}
          onLayout={(e) => {
            // Spread whole seats so the first and last touch the card's text lines.
            const width = e.nativeEvent.layout.width;
            const perRow = Math.max(
              2,
              Math.floor((width + SEAT_GAP_MIN) / (SEAT + SEAT_GAP_MIN))
            );
            setSeatGap(Math.floor((width - perRow * SEAT) / (perRow - 1)));
          }}
        >
          {members.map((m) => {
            const on = m.peerId === selectedPeerId;
            return (
              <Pressable
                key={m.peerId}
                accessibilityRole="button"
                accessibilityLabel={`${m.alias}${m.isSelf ? ', you' : ''}${
                  m.online ? '' : ', away'
                }${m.inVoice ? ', in the call' : ''}`}
                accessibilityState={{ selected: on }}
                onPress={() => {
                  setSelectedPeerId(on ? null : m.peerId);
                  setMemberNotice(null);
                }}
                style={styles.gridCell}
              >
                <Piece alias={m.alias} size={SEAT} away={!m.online} speaking={on} />
              </Pressable>
            );
          })}
          {Array.from({ length: freeSeats }, (_, i) => (
            <View
              key={`free-${i}`}
              style={styles.gridCell}
              accessibilityElementsHidden
            >
              <View style={styles.freeSeat} />
            </View>
          ))}
        </View>
        )}
      </View>

      {selected ? (
        <View style={[styles.memberCard, { backgroundColor: pieceColor(selected.alias) }]}>
          <Text style={styles.memberName}>
            {selected.alias}
            {selected.isSelf || selected.peerId === activePod.myPeerId ? ' (you)' : ''}
          </Text>
          <Text style={styles.memberSub}>
            {selected.online ? 'Online' : 'Away'}
            {selected.inVoice ? ' · in the call' : ''}
            {selected.role === 'OWNER' ? ' · runs this group' : ''}
            {selected.role === 'ADMIN' ? ' · admin' : ''}
          </Text>
          {selected.customStatus && !(selected.isSelf || selected.peerId === activePod.myPeerId) ? (
            <Text style={styles.memberSub}>{selected.customStatus}</Text>
          ) : null}
          {selected.isSelf || selected.peerId === activePod.myPeerId ? (
            <View style={styles.selfStatusRow}>
              <TextInput
                value={statusDraft}
                onChangeText={setStatusDraft}
                placeholder="A line under your alias"
                placeholderTextColor={PIECES.muted}
                maxLength={80}
                accessibilityLabel="Your status in this room"
                style={[fieldStyles.input, styles.selfStatusInput]}
              />
              <Btn
                label="Save"
                kind="ink"
                loading={statusMutation.isPending}
                onPress={() => statusMutation.mutate(statusDraft.trim())}
              />
            </View>
          ) : (
            <View style={styles.controls}>
              <Btn
                label="Write"
                kind="ink"
                onPress={() => openWrite(selected.peerId)}
                a11yLabel={`Write to ${selected.alias} privately`}
                style={styles.control}
              />
              <Btn
                label="Call"
                kind="white"
                icon="call-outline"
                onPress={() => startPrivateCall(selected.peerId, selected.alias, selected.online)}
                a11yLabel={`Call ${selected.alias} privately`}
                style={styles.control}
              />
              {!isProRoom ? (
                <Btn
                  label="Vote to remove"
                  kind="white"
                  onPress={() => voteToRemove(selected.peerId, selected.alias)}
                  a11yLabel={`Start a vote to remove ${selected.alias}`}
                  style={styles.control}
                />
              ) : null}
              {canAdminManage && activePod.myRole === 'OWNER' && selected.role !== 'OWNER' ? (
                <Btn
                  label={selected.role === 'ADMIN' ? 'Take admin away' : 'Make admin'}
                  kind="white"
                  disabled={adminRoleMutation.isPending}
                  onPress={() =>
                    adminRoleMutation.mutate({
                      targetPeerId: selected.peerId,
                      role: selected.role === 'ADMIN' ? 'MEMBER' : 'ADMIN',
                    })
                  }
                  style={styles.control}
                />
              ) : null}
              {canAdminManage && selected.role !== 'OWNER' ? (
                <Btn
                  label="Remove"
                  kind="off"
                  disabled={adminKickMutation.isPending}
                  onPress={() => adminKickMutation.mutate(selected.peerId)}
                  a11yLabel={`Remove ${selected.alias} from the group`}
                  style={styles.control}
                />
              ) : null}
            </View>
          )}
          {memberNotice ? <Text style={styles.memberSub}>{memberNotice}</Text> : null}
        </View>
      ) : null}
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: PIECES.bg },
  content: { padding: GUTTER, gap: GUTTER, paddingBottom: 24 },
  flex1: { flex: 1 },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
    backgroundColor: PIECES.bg,
  },
  emptyTitle: { fontSize: 24, fontWeight: '600', color: PIECES.ink },
  emptySub: { fontSize: 16, color: PIECES.muted, textAlign: 'center', lineHeight: 23 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: INSET },
  roomName: { fontSize: 26, lineHeight: 30, color: PIECES.ink, fontWeight: '600' },
  roomMeta: { fontSize: 14, color: PIECES.muted, fontFamily: MONO_FONT },
  wsDot: { width: 10, height: 10, borderRadius: 5 },
  chipsRow: { flexDirection: 'row', gap: 8, paddingRight: 8 },
  callCard: { backgroundColor: PIECES.ink, borderRadius: 28, padding: INSET, gap: 14 },
  callTitle: { fontSize: 22, lineHeight: 26, color: PIECES.sheet, fontWeight: '600' },
  callSub: { fontSize: 14, lineHeight: 20, color: '#d0d0d0' },
  callPeers: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 10 },
  callPeer: { gap: 4, width: 76 },
  // Room for the speaking ring, so nobody jumps when they start to talk.
  callPiece: { height: 56, alignItems: 'flex-start', justifyContent: 'flex-end' },
  callPeerState: { fontSize: 12, color: '#d0d0d0', fontFamily: MONO_FONT },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  control: { flexGrow: 1 },
  sheetCard: { backgroundColor: PIECES.sheet, borderRadius: 28, padding: INSET, gap: 12 },
  h3: { fontSize: 18, lineHeight: 22, color: PIECES.ink, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  gridCell: {
    width: SEAT,
    minHeight: 68,
    alignItems: 'center',
    justifyContent: 'center',
  },
  freeSeat: {
    width: SEAT,
    height: SEAT,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: PIECES.hair,
  },
  memberCard: { borderRadius: 28, padding: INSET, gap: 8 },
  memberName: { fontSize: 26, color: PIECES.ink, fontWeight: '600' },
  memberSub: { fontSize: 15, color: PIECES.ink },
  phoneBar: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: GUTTER,
    paddingVertical: 6,
    backgroundColor: PIECES.sheet,
    borderBottomWidth: 1,
    borderBottomColor: PIECES.hair,
  },
  phoneRoomName: { fontSize: 20, lineHeight: 24, color: PIECES.ink, fontWeight: '600' },
  roundBtn: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: TOUCH_MIN / 2,
    backgroundColor: PIECES.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cornerBadge: { position: 'absolute', top: -6, right: -6 },
  seatsHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  listCol: { gap: 4 },
  memberListRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 8,
    borderRadius: 22,
  },
  memberListName: { fontSize: 16, fontWeight: '600', color: PIECES.ink },
  memberListMeta: { fontSize: 13, color: PIECES.ink2 },
  selfStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  selfStatusInput: { flex: 1, backgroundColor: PIECES.sheet },
});

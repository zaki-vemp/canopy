'use client';

import { useAtom, useSetAtom } from 'jotai';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import {
  highlightedMessageIdAtom,
  rightPanelAtom,
} from '@/state/workspaceAtoms';
import { patchMessageAcrossCaches } from '@/state/wsPodClient';
import { roomName, useOpenConversation } from '@/state/roomActions';
import { CallCard } from '@/components/workspace/CallCard';
import { MessageCard } from '@/components/workspace/MessageCard';
import { PeoplePanel } from '@/components/workspace/PeoplePanel';
import { VotesPanel } from '@/components/workspace/VotesPanel';
import {
  resolveMessagePeerId,
  type PodDetail,
  type PodMember,
  type RichMessage,
} from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import s from '@/app/app/workspace.module.css';

function KeptMessages({
  messages,
  loading,
  empty,
  pods,
  showRoom,
}: {
  messages: RichMessage[] | undefined;
  loading: boolean;
  empty: string;
  pods: PodDetail[];
  showRoom: boolean;
}) {
  const openConversation = useOpenConversation();
  const setHighlighted = useSetAtom(highlightedMessageIdAtom);
  const queryClient = useQueryClient();
  const unsave = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ message: RichMessage }>(`/api/messages/${id}/bookmark`, { method: 'POST' }),
    onSuccess: (res) => {
      patchMessageAcrossCaches(queryClient, res.message.podId, res.message, false);
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
    },
  });

  if (loading) return <p className={s.hint}>Fetching them.</p>;
  if (!messages?.length) return <p className={s.hint}>{empty}</p>;

  return (
    <>
      {messages.map((msg) => {
        const room = pods.find((p) => p.podId === msg.podId);
        const myPeerId = room?.myPeerId ?? '';
        const peerId = resolveMessagePeerId(
          msg.senderPeerId,
          msg.recipientPeerId,
          myPeerId
        );
        const peerAlias =
          msg.senderPeerId === myPeerId ? msg.recipientAlias : msg.senderAlias;
        return (
          <div key={msg.id} className={ui.stack} style={{ gap: 6 }}>
            {showRoom && room && (
              <p className={ui.hint}>
                {roomName(room)}
                {peerId ? `, privately with ${peerAlias}` : ''}
              </p>
            )}
            <MessageCard
              message={msg}
              myPeerId={myPeerId}
              knownAliases={room?.members.map((m) => m.alias) ?? []}
              compact
            />
            <div className={ui.row}>
              {room && (
                <button
                  type="button"
                  className={`${ui.btn} ${ui.small}`}
                  onClick={() => {
                    openConversation(msg.podId, peerId);
                    setHighlighted(msg.id);
                  }}
                >
                  Go to it
                </button>
              )}
              {showRoom && (
                <button
                  type="button"
                  className={`${ui.btn} ${ui.small}`}
                  disabled={unsave.isPending}
                  onClick={() => unsave.mutate(msg.id)}
                >
                  Unsave
                </button>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

export function SidePanel({
  pod,
  pods,
  members,
  activePeerId,
}: {
  pod: PodDetail | null;
  pods: PodDetail[];
  members: PodMember[];
  activePeerId: string | null;
}) {
  const [panel, setPanel] = useAtom(rightPanelAtom);
  const mode = panel === null || panel === 'search' ? 'members' : panel;

  const pins = useQuery<{ messages: RichMessage[] }>({
    queryKey: ['pins', pod?.podId || ''],
    queryFn: () =>
      apiFetch<{ messages: RichMessage[] }>(`/api/pods/${pod!.podId}/pins`),
    enabled: Boolean(mode === 'pins' && pod),
  });
  const saved = useQuery<{ messages: RichMessage[] }>({
    queryKey: ['bookmarks'],
    queryFn: () => apiFetch<{ messages: RichMessage[] }>('/api/bookmarks'),
    enabled: mode === 'bookmarks',
  });

  return (
    <aside
      className={s.right}
      aria-label={
        mode === 'votes'
          ? 'Votes'
          : mode === 'pins'
            ? 'Pinned messages'
            : mode === 'bookmarks'
              ? 'Saved messages'
              : 'The room'
      }
    >
      <div className={s.side}>
        {mode !== 'members' && (
          <div className={s.sideHead}>
            <h2>
              {mode === 'votes' ? 'Votes' : mode === 'pins' ? 'Pinned' : 'Saved'}
            </h2>
            <button
              type="button"
              className={`${ui.btn} ${ui.small}`}
              onClick={() => setPanel('members')}
            >
              Back to seats
            </button>
          </div>
        )}

        {mode === 'members' &&
          (pod ? (
            <PeoplePanel
              key={pod.podId}
              pod={pod}
              pods={pods}
              members={members}
              activePeerId={activePeerId}
            />
          ) : (
            <p className={s.hint}>Seats show up here once you are in a room.</p>
          ))}

        {mode === 'votes' && pod && <VotesPanel key={pod.podId} pod={pod} members={members} />}

        {mode === 'pins' && (
          <KeptMessages
            messages={pins.data?.messages}
            loading={pins.isLoading}
            empty="Nothing is pinned. Open any message's menu and press the pin."
            pods={pods}
            showRoom={false}
          />
        )}

        {mode === 'bookmarks' && (
          <KeptMessages
            messages={saved.data?.messages}
            loading={saved.isLoading}
            empty="Nothing saved yet. Saved messages from every room land here, and only you see them."
            pods={pods}
            showRoom
          />
        )}
      </div>

      {pod && <CallCard pod={pod} members={members} />}
    </aside>
  );
}

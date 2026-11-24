'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { apiFetch } from '@/lib/api';
import { PIECE_COLORS, colorVar } from '@/lib/pieces';
import { authRevisionAtom, selfUserAtom } from '@/state/authAtoms';
import {
  adminSettingsPodIdAtom,
  interestModalOpenAtom,
  interestModalTabAtom,
  inviteModalPodIdAtom,
  presenceByPodAtom,
  type InterestModalTab,
} from '@/state/workspaceAtoms';
import {
  roomName,
  setPods,
  useLeaveRoom,
  useOpenConversation,
  useRoomCall,
} from '@/state/roomActions';
import { Dialog } from '@/components/pieces/Dialog';
import { SeatDots } from '@/components/pieces/Piece';
import { SizeChoice } from '@/components/workspace/SizeChoice';
import { VisibilityChoice } from '@/components/workspace/GroupSettingsDialog';
import {
  extractInviteCode,
  sanitizeCustomPodCode,
  type AcceptInviteResponse,
  type CreateCustomPodRequest,
  type InterestItem,
  type MatchRequest,
  type PodCapacityPreset,
  type PodDetail,
  type PublicizedPodDto,
  type SelfUser,
} from '@/types/canopy';
import ui from '@/components/pieces/ui.module.css';
import d from './dialogs.module.css';

interface Joined {
  pod?: PodDetail;
  matched?: PodDetail[];
  pods: PodDetail[];
}

const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

export function RoomsDialog({ pods }: { pods: PodDetail[] }) {
  const [open, setOpen] = useAtom(interestModalOpenAtom);
  return open ? <Rooms pods={pods} onClose={() => setOpen(false)} /> : null;
}

function Rooms({ pods, onClose }: { pods: PodDetail[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useAtom(interestModalTabAtom);
  const openConversation = useOpenConversation();

  const interests = useQuery<{ interests: InterestItem[] }>({
    queryKey: ['interests'],
    queryFn: () => apiFetch<{ interests: InterestItem[] }>('/api/interests'),
  });
  const list = interests.data?.interests ?? [];

  // Every way in ends the same: the new list of rooms, and you in the new one.
  const enter = (res: Joined) => {
    setPods(queryClient, res.pods);
    queryClient.invalidateQueries({ queryKey: ['publicized-pods'] });
    const target = res.pod ?? res.matched?.[0] ?? res.pods[res.pods.length - 1];
    if (target) openConversation(target.podId, null);
    onClose();
  };

  const tabs: Array<{ id: InterestModalTab; name: string }> = [
    ...(pods.length > 0 ? [{ id: 'pods' as const, name: `Your rooms ${pods.length}` }] : []),
    { id: 'match', name: 'Find a room' },
    { id: 'publicized', name: 'Listed groups' },
    { id: 'custom', name: 'Start a group' },
  ];
  const current = tab === 'pods' && pods.length === 0 ? 'match' : tab;

  const shared = { onEnter: enter, onClose };

  return (
    <Dialog {...HEADS[current]} width={820} onClose={onClose} bare>
      <div className={d.tabs} role="tablist" aria-label="Rooms">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={current === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.name}
          </button>
        ))}
      </div>
      {current === 'pods' && <YourRooms {...shared} pods={pods} />}
      {current === 'match' && (
        <FindRoom {...shared} pods={pods} interests={list} loading={interests.isLoading} />
      )}
      {current === 'publicized' && <Listed {...shared} pods={pods} interests={list} />}
      {current === 'custom' && <OwnGroup {...shared} interests={list} />}
    </Dialog>
  );
}

const HEADS: Record<InterestModalTab, { title: string; lead: string }> = {
  pods: { title: 'Your rooms', lead: 'You are someone else in every one of them.' },
  match: {
    title: 'Pick up a hobby',
    lead: 'You get a seat in a room of people who picked the same one, and an alias to sit under.',
  },
  publicized: {
    title: 'Listed groups',
    lead: 'Someone runs these. You still come in under an alias.',
  },
  custom: {
    title: 'Start a group',
    lead: 'You run it. Everyone in it, you too, sits under an alias.',
  },
};

interface TabProps {
  onEnter: (res: Joined) => void;
  onClose: () => void;
}

function Problem({ error }: { error: Error | null | undefined }) {
  return error ? (
    <p className={ui.alert} role="alert">
      {error.message}
    </p>
  ) : null;
}

function FindRoom({
  pods,
  interests,
  loading,
  onEnter,
  onClose,
}: TabProps & { pods: PodDetail[]; interests: InterestItem[]; loading: boolean }) {
  const [picked, setPicked] = useState<string[] | null>(null);
  const [own, setOwn] = useState<string[]>([]);
  const [ownText, setOwnText] = useState('');
  const [size, setSize] = useState<PodCapacityPreset>(null);
  const [fresh, setFresh] = useState(false);

  const seatedIn = (slug: string) => pods.filter((p) => p.interestSlug === slug).length;

  // Hobbies you chose before and have no room for yet start out picked up.
  useEffect(() => {
    if (picked === null && interests.length > 0) {
      setPicked(interests.filter((i) => i.selected && !seatedIn(i.slug)).map((i) => i.slug));
    }
  }, [interests, picked]);

  const chosen = [...(picked ?? []), ...own];

  const join = useMutation({
    mutationFn: async () => {
      const saved = interests.filter((i) => i.selected).map((i) => i.slug);
      await apiFetch<{ interests: InterestItem[] }>('/api/me/interests', {
        method: 'PUT',
        body: JSON.stringify({ interests: [...new Set([...saved, ...chosen])] }),
      });
      let last: Joined = { pods };
      let first: PodDetail | undefined;
      for (const interest of chosen) {
        const req: MatchRequest = {
          interest,
          matchAll: false,
          maxMembers: size,
          forceNewPod: fresh,
          allowAdditional: fresh || seatedIn(interest) > 0,
        };
        last = await apiFetch<Joined>('/api/pods/match', {
          method: 'POST',
          body: JSON.stringify(req),
        });
        first ??= last.matched?.[0];
      }
      return { pods: last.pods, pod: first };
    },
    onSuccess: onEnter,
  });

  const toggle = (slug: string) =>
    setPicked((prev) =>
      prev?.includes(slug) ? prev.filter((x) => x !== slug) : [...(prev ?? []), slug]
    );

  const addOwn = (e: FormEvent) => {
    e.preventDefault();
    const name = ownText.trim();
    if (name && !own.includes(name)) setOwn([...own, name]);
    setOwnText('');
  };

  return (
    <>
      <div className={ui.body}>
      <Problem error={join.error} />
      {loading && <p className={ui.hint}>Laying them out.</p>}
      <div className={d.hobbies}>
        {interests.map((item, i) => {
          const seats = seatedIn(item.slug);
          return (
            <button
              key={item.slug}
              type="button"
              className={d.hobby}
              style={{ '--c': `var(--c-${PIECE_COLORS[(i * 5 + 1) % PIECE_COLORS.length]})` } as React.CSSProperties}
              aria-pressed={picked?.includes(item.slug) ?? false}
              onClick={() => toggle(item.slug)}
            >
              <b>{item.label}</b>
              <small>
                {seats > 0
                  ? `You are in ${seats === 1 ? 'a room' : `${seats} rooms`}`
                  : item.activeMembers > 0
                    ? `${people(item.activeMembers)}, ${item.openPods} open`
                    : 'Be the first'}
              </small>
            </button>
          );
        })}
        {own.map((name) => (
          <button
            key={name}
            type="button"
            className={d.hobby}
            style={colorVar(name)}
            aria-pressed="true"
            aria-label={`${name}. Put it back`}
            onClick={() => setOwn(own.filter((x) => x !== name))}
          >
            <b>{name}</b>
            <small>Yours</small>
          </button>
        ))}
      </div>

      <form className={`${ui.row} ${ui.nowrap}`} onSubmit={addOwn}>
        <input
          className={`${ui.input} ${ui.grow}`}
          value={ownText}
          onChange={(e) => setOwnText(e.target.value)}
          maxLength={48}
          placeholder="Something else? Type it"
          aria-label="Another hobby"
        />
        <button type="submit" className={`${ui.btn} ${ui.big}`} disabled={!ownText.trim()}>
          Add it
        </button>
      </form>

      <div className={ui.field}>
        <span>Room size</span>
        <SizeChoice value={size} onChange={setSize} any />
      </div>
      <div className={ui.field}>
        <span>Which room</span>
        <div className={ui.choices} role="group" aria-label="Which room">
          <button type="button" className={ui.choice} aria-pressed={!fresh} onClick={() => setFresh(false)}>
            One with people in it
          </button>
          <button type="button" className={ui.choice} aria-pressed={fresh} onClick={() => setFresh(true)}>
            A brand new one
          </button>
        </div>
      </div>
      <InviteEntry onEnter={onEnter} />
      </div>
      <footer className={ui.foot}>
          <span>
            {chosen.length === 0 ? 'Nothing picked yet' : `${chosen.length} picked`}
          </span>
          <button
            type="button"
            className={`${ui.btn} ${ui.big} ${ui.blue}`}
            disabled={chosen.length === 0 || join.isPending}
            onClick={() => join.mutate()}
          >
            {join.isPending
              ? 'Finding your seat'
              : chosen.length > 1
                ? `Join ${chosen.length} rooms`
                : 'Join a room'}
          </button>
      </footer>
    </>
  );
}

function InviteEntry({ onEnter }: { onEnter: (res: Joined) => void }) {
  const [text, setText] = useState('');
  const accept = useMutation({
    mutationFn: () => {
      const code = extractInviteCode(text);
      if (!code) throw new Error('That is not an invite link or code.');
      return apiFetch<AcceptInviteResponse>(`/api/invites/${encodeURIComponent(code)}/accept`, {
        method: 'POST',
      });
    },
    onSuccess: onEnter,
  });
  return (
    <form
      className={d.invite}
      onSubmit={(e) => {
        e.preventDefault();
        accept.mutate();
      }}
    >
      <label className={ui.label} htmlFor="invite-code">
        Got an invite?
      </label>
      <div className={`${ui.row} ${ui.nowrap}`}>
        <input
          id="invite-code"
          className={`${ui.input} ${ui.grow}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the link or the code"
        />
        <button type="submit" className={`${ui.btn} ${ui.big} ${ui.ink}`} disabled={!text.trim() || accept.isPending}>
          Go in
        </button>
      </div>
      <Problem error={accept.error} />
    </form>
  );
}

function YourRooms({ pods, onEnter, onClose }: TabProps & { pods: PodDetail[] }) {
  const setTab = useSetAtom(interestModalTabAtom);
  const leave = useLeaveRoom(pods);
  const another = useMutation({
    mutationFn: (interest: string) =>
      apiFetch<Joined>('/api/pods/match', {
        method: 'POST',
        body: JSON.stringify({ interest, matchAll: false, allowAdditional: true } satisfies MatchRequest),
      }),
    onSuccess: onEnter,
  });
  const busy = leave.isPending || another.isPending;

  return (
    <>
      <div className={ui.body}>
      <Problem error={leave.error ?? another.error} />
      <div className={d.rooms}>
        {pods.map((pod) => (
          <RoomBlock
            key={pod.podId}
            pod={pod}
            busy={busy}
            onClose={onClose}
            onLeave={(rematch) => leave.mutate({ podId: pod.podId, rematch })}
            onAnother={() => another.mutate(pod.interestSlug)}
          />
        ))}
      </div>
      </div>
      <footer className={ui.foot}>
          <button type="button" className={`${ui.btn} ${ui.big} ${ui.blue}`} onClick={() => setTab('match')}>
            Join another room
          </button>
      </footer>
    </>
  );
}

function RoomBlock({
  pod,
  busy,
  onClose,
  onLeave,
  onAnother,
}: {
  pod: PodDetail;
  busy: boolean;
  onClose: () => void;
  onLeave: (rematch: boolean) => void;
  onAnother: () => void;
}) {
  const openConversation = useOpenConversation();
  const setInvitePod = useSetAtom(inviteModalPodIdAtom);
  const setSettingsPod = useSetAtom(adminSettingsPodIdAtom);
  const presence = useAtomValue(presenceByPodAtom);
  const { peers } = useRoomCall(pod);
  const [leaving, setLeaving] = useState(false);
  const proRoom = pod.governanceMode === 'ADMIN';
  const taken = presence[pod.podId]?.members.length || pod.memberCount;
  const glass = `${ui.btn} ${ui.glass}`;

  return (
    <article className={d.room} style={colorVar(pod.myAlias)}>
      <div className={d.roomHead}>
        <div>
          <h3>{roomName(pod)}</h3>
          <p>
            You are {pod.myAlias}
            {peers.length > 0 && `, ${people(peers.length)} in the call`}
          </p>
          <p className={ui.code}>{pod.code}</p>
        </div>
        <span title={`${taken} of ${pod.maxMembers} seats`}>
          <SeatDots taken={taken} total={pod.maxMembers} columns={10} />
        </span>
      </div>
      {leaving ? (
        <div className={ui.row}>
          <button type="button" className={glass} onClick={() => setLeaving(false)}>
            Stay
          </button>
          {!proRoom && (
            <button type="button" className={glass} disabled={busy} onClick={() => onLeave(true)}>
              Swap it for another
            </button>
          )}
          <button type="button" className={`${ui.btn} ${ui.ink}`} disabled={busy} onClick={() => onLeave(false)}>
            Leave for good
          </button>
        </div>
      ) : (
        <div className={ui.row}>
          <button
            type="button"
            className={`${ui.btn} ${ui.ink}`}
            onClick={() => {
              openConversation(pod.podId, null);
              onClose();
            }}
          >
            Open
          </button>
          <button type="button" className={glass} onClick={() => setInvitePod(pod.podId)}>
            Invite
          </button>
          {proRoom && pod.myRole !== 'MEMBER' && (
            <button
              type="button"
              className={glass}
              onClick={() => {
                onClose();
                setSettingsPod(pod.podId);
              }}
            >
              Manage
            </button>
          )}
          {!proRoom && (
            <button type="button" className={glass} disabled={busy} onClick={onAnother}>
              Another {pod.interestLabel} room
            </button>
          )}
          <button type="button" className={glass} onClick={() => setLeaving(true)}>
            Leave
          </button>
        </div>
      )}
    </article>
  );
}

function Listed({
  pods,
  interests,
  onEnter,
  onClose,
}: TabProps & { pods: PodDetail[]; interests: InterestItem[] }) {
  const openConversation = useOpenConversation();
  const setTab = useSetAtom(interestModalTabAtom);
  const [filter, setFilter] = useState('');
  const listed = useQuery<{ groups: PublicizedPodDto[] }>({
    queryKey: ['publicized-pods', filter],
    queryFn: () =>
      apiFetch<{ groups: PublicizedPodDto[] }>(
        `/api/pods/publicized${filter ? `?interest=${encodeURIComponent(filter)}` : ''}`
      ),
  });
  const join = useMutation({
    mutationFn: (podId: string) =>
      apiFetch<{ pod: PodDetail; pods: PodDetail[] }>(`/api/pods/${podId}/join`, { method: 'POST' }),
    onSuccess: onEnter,
  });
  const groups = listed.data?.groups ?? [];

  return (
    <>
      <div className={ui.body}>
      <Problem error={listed.error ?? join.error} />
      <label className={ui.field}>
        <span>Hobby</span>
        <select className={ui.input} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All of them</option>
          {interests.map((i) => (
            <option key={i.slug} value={i.slug}>
              {i.label}
            </option>
          ))}
        </select>
      </label>
      {listed.isSuccess && groups.length === 0 && (
        <div className={ui.stack}>
          <p className={ui.hint}>No group is listed here yet.</p>
          <button type="button" className={ui.btn} style={{ justifySelf: 'start' }} onClick={() => setTab('custom')}>
            Start one
          </button>
        </div>
      )}
      <div className={d.rooms}>
        {groups.map((g) => {
          const inside = g.alreadyMember || pods.some((p) => p.podId === g.podId);
          const full = g.memberCount >= g.maxMembers;
          return (
            <article key={g.podId} className={d.room} style={colorVar(g.founderAlias)}>
              <div className={d.roomHead}>
                <div>
                  <h3>{g.title || g.interestLabel}</h3>
                  {g.description && <p>{g.description}</p>}
                  <p>
                    {g.interestLabel}, started by {g.founderAlias}
                  </p>
                </div>
                <span title={`${g.memberCount} of ${g.maxMembers} seats`}>
                  <SeatDots taken={g.memberCount} total={g.maxMembers} columns={10} />
                </span>
              </div>
              <div className={ui.row}>
                {inside ? (
                  <button
                    type="button"
                    className={`${ui.btn} ${ui.ink}`}
                    onClick={() => {
                      openConversation(g.podId, null);
                      onClose();
                    }}
                  >
                    Open
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${ui.btn} ${ui.ink}`}
                    disabled={full || join.isPending}
                    onClick={() => join.mutate(g.podId)}
                  >
                    {full ? 'Full' : 'Join'}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      </div>
    </>
  );
}

function OwnGroup({ interests, onEnter }: TabProps & { interests: InterestItem[] }) {
  const queryClient = useQueryClient();
  const user = useAtomValue(selfUserAtom);
  const revision = useAtomValue(authRevisionAtom);
  const [title, setTitle] = useState('');
  const [handle, setHandle] = useState('');
  const [handleTouched, setHandleTouched] = useState(false);
  const [interest, setInterest] = useState('');
  const [about, setAbout] = useState('');
  const [size, setSize] = useState<10 | 25 | 50>(25);
  const [listed, setListed] = useState(false);

  const upgrade = useMutation({
    mutationFn: () =>
      apiFetch<{ user: SelfUser }>('/api/auth/plan', {
        method: 'POST',
        body: JSON.stringify({ planTier: 'PREMIUM' }),
      }),
    onSuccess: (res) => queryClient.setQueryData(['auth', 'me', revision], res),
  });

  const create = useMutation({
    mutationFn: () => {
      const code = sanitizeCustomPodCode(handle || title);
      if (!title.trim()) throw new Error('Give the group a name.');
      if (code.length < 3) throw new Error('The handle needs three letters or numbers at least.');
      const payload: CreateCustomPodRequest = {
        title: title.trim(),
        code,
        interest: interest || interests[0]?.slug || 'gaming',
        description: about.trim(),
        maxMembers: size,
        isPublicized: listed,
      };
      return apiFetch<{ pod: PodDetail; pods: PodDetail[] }>('/api/pods/custom', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: onEnter,
  });

  if (user?.planTier !== 'PREMIUM') {
    return (
      <>
      <div className={ui.body}>
        <Problem error={upgrade.error} />
        <div className={d.pro}>
          <h3>Matched rooms run on votes. A Pro group runs on you.</h3>
          <ul>
            <li>Your own name and handle, with 10, 25 or 50 seats</li>
            <li>Kept to an invite link, or listed for anyone to join</li>
            <li>You pick admins and remove people without a vote</li>
          </ul>
          <button
            type="button"
            className={`${ui.btn} ${ui.big} ${ui.ink}`}
            style={{ justifySelf: 'start' }}
            disabled={upgrade.isPending}
            onClick={() => upgrade.mutate()}
          >
            Switch to Pro
          </button>
        </div>
      </div>
    </>
    );
  }

  return (
    <>
      <div className={ui.body}>
      <form
        id="own-group"
        className={ui.stack}
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Problem error={create.error} />
        <div className={ui.two}>
          <label className={ui.field}>
            <span>Name</span>
            <input
              className={ui.input}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (!handleTouched) setHandle(sanitizeCustomPodCode(e.target.value));
              }}
              maxLength={80}
              placeholder="Thursday Blitz"
              required
            />
          </label>
          <label className={ui.field}>
            <span>Handle</span>
            <span className={d.handle}>
              #
              <input
                value={handle}
                onChange={(e) => {
                  setHandleTouched(true);
                  setHandle(sanitizeCustomPodCode(e.target.value));
                }}
                maxLength={32}
                placeholder="thursday-blitz"
                required
              />
            </span>
          </label>
        </div>
        <label className={ui.field}>
          <span>Hobby</span>
          <select className={ui.input} value={interest || interests[0]?.slug} onChange={(e) => setInterest(e.target.value)}>
            {interests.map((i) => (
              <option key={i.slug} value={i.slug}>
                {i.label}
              </option>
            ))}
          </select>
        </label>
        <label className={ui.field}>
          <span>What it is about</span>
          <input className={ui.input} value={about} onChange={(e) => setAbout(e.target.value)} maxLength={240} />
        </label>
        <div className={ui.field}>
          <span>Size</span>
          <SizeChoice value={size} onChange={(v) => v && setSize(v)} />
        </div>
        <div className={ui.field}>
          <span>Who can find it</span>
          <VisibilityChoice listed={listed} onChange={setListed} />
        </div>
      </form>
      </div>
      <footer className={ui.foot}>
          <button type="submit" form="own-group" className={`${ui.btn} ${ui.big} ${ui.blue}`} disabled={create.isPending}>
            Start the group
          </button>
      </footer>
    </>
  );
}

'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';

const DIAGRAM_SPEC = JSON.stringify({
  layout: 'hub',
  alt: 'Canopy separates private login verification from 25-seat democratic pods, Pro groups, room aliases, votes, and voice lounges.',
  center: { label: 'Canopy', icon: 'text:Mu' },
  spokes: [
    { label: 'Auth vault', icon: 'ui:user' },
    { label: '25-seat pod', icon: 'ui:gamepad-2' },
    { label: 'Cobalt Fox', icon: 'ui:users' },
    { label: 'Yes/No votes', icon: 'ui:message-square' },
    { label: 'Lounge Voice', icon: 'ui:captions' },
    { label: 'Pro groups', icon: 'ui:refresh-cw' },
  ],
});

const LANDING_CSS = `
:root {
  --p-bg: #ffffff; --p-surface: #f3f3f3; --p-ink: #232323; --p-muted: #686868;
  --p-accent: #a1ffcb; --p-accent-ink: #232323; --p-action: #232323; --p-action-ink: #ffffff;
  --p-inv-bg: #232323; --p-inv-surface: #303030; --p-inv-ink: #ffffff; --p-inv-muted: #a4a4a4;
  --p-inv-accent: #a1ffcb; --p-inv-accent-ink: #232323; --p-inv-action: #a1ffcb; --p-inv-action-ink: #232323;
  --font-display: "Familjen Grotesk", system-ui, sans-serif;
  --font-text: "Familjen Grotesk", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --display-weight: 400;
  --display-tracking: -0.03em;
  --display-tracking-xl: -0.04em;
}
@media (max-width: 379px) {
  .nav__bar { gap: 6px; }
  .nav__logo { font-size: 15px; gap: 5px; }
  .nav__logo .mark:not(.mark--initial) { width: 16px; height: 16px; }
  .nav:not(.is-open) .nav__actions .btn { padding-inline: 8px; font-size: 12px; }
  .nav:not(.is-open) .nav__actions .btn .m-arrow { display: none; }
}
.hero--split .hero__media {
  background-color: var(--ground-bg);
  background-image:
    radial-gradient(70% 90% at 15% 0%, color-mix(in oklab, var(--ground-surface) 92%, white), transparent 72%),
    radial-gradient(60% 80% at 100% 100%, color-mix(in oklab, var(--ground-accent) 28%, var(--ground-bg)), transparent 72%);
}
.m-pod-win {
  position: absolute;
  inset: 28px 28px 116px 28px;
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  background: #ffffff;
  color: #232323;
  border: 1px solid rgba(35, 35, 35, 0.14);
  border-radius: 12px;
  overflow: hidden;
  font: 400 13px/1.4 var(--font-text);
}
.m-pod-side {
  background: #f3f3f3;
  border-right: 1px solid rgba(35, 35, 35, 0.1);
  padding: 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.m-pod-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 500;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(35, 35, 35, 0.1);
  margin-bottom: 4px;
}
.m-pod-code { font-family: var(--font-mono); font-size: 12px; }
.m-pod-cap {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 6px;
  background: #ffffff;
  border: 1px solid rgba(35, 35, 35, 0.12);
}
.m-pod-lbl { font-size: 11px; font-weight: 500; color: #555555; margin-top: 6px; }
.m-pod-ch { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 6px; color: #232323; font-size: 12px; }
.m-pod-ch.is-active { background: #232323; color: #ffffff; font-weight: 500; }
.m-pod-voice { margin-top: 4px; padding: 8px; border-radius: 8px; background: #ffffff; border: 1px solid rgba(35, 35, 35, 0.1); display: grid; gap: 6px; }
.m-pod-vpeer { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.m-ring { width: 8px; height: 8px; border-radius: 50%; background: #a1ffcb; box-shadow: 0 0 0 2px #1f6b3a; flex: none; }
.m-ring--idle { background: #d8deda; box-shadow: none; }
.m-pod-main { display: flex; flex-direction: column; min-width: 0; background: #ffffff; }
.m-pod-bar { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid rgba(35, 35, 35, 0.1); font-size: 12px; }
.m-pod-feed { padding: 12px 14px; display: grid; gap: 10px; overflow: hidden; }
.m-msg { display: grid; gap: 3px; }
.m-msg__top { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
.m-alias { font-weight: 500; color: #1f6b3a; }
.m-alias--amber { color: #8c430f; }
.m-alias--slate { color: #234e63; }
.m-time { font-family: var(--font-mono); font-size: 11px; color: #545454; }
.m-msg__body { font-size: 13px; color: #232323; }
.m-thread-chip { display: inline-flex; align-items: center; gap: 6px; width: fit-content; margin-top: 2px; padding: 3px 8px; border-radius: 6px; background: #f3f3f3; font-size: 11px; font-weight: 500; color: #232323; }
.m-poll-box { padding: 10px 12px; border-radius: 8px; background: #f3f3f3; border: 1px solid rgba(35, 35, 35, 0.1); display: grid; gap: 6px; }
.m-poll-q { font-weight: 500; font-size: 12px; }
.m-poll-opt { display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; border-radius: 6px; background: #ffffff; border: 1px solid rgba(35, 35, 35, 0.1); font-size: 12px; }
.m-poll-opt.is-lead { border-color: #1f6b3a; background: color-mix(in oklab, #a1ffcb 32%, #ffffff); font-weight: 500; }
@media (max-width: 1023px) {
  .hero--split .ly-float { display: none; }
  .m-pod-win { inset: 20px 20px 24px 20px; }
}
@media (max-width: 639px) {
  .m-pod-win { inset: 14px 14px 20px 14px; grid-template-columns: minmax(0, 1fr); }
  .m-pod-side { display: none; }
}
.app.ui {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  margin-top: var(--s-7);
  background: #ffffff;
  border: 1px solid rgba(35, 35, 35, 0.14);
  border-radius: var(--r-md);
  overflow: hidden;
}
.app > .app__pane { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
.app > .app__pane + .app__pane { border-left: 1px solid rgba(35, 35, 35, 0.1); }
.app > .app__pane > .ui-panel { width: 100%; border: 0; border-radius: 0; box-shadow: none; }
.app .ui-win__st, .app .ui-win__age, .app .ui-win__ph { color: #545454; }
.app > .app__pane::after { content: ""; position: absolute; inset: auto 0 0 0; height: 56px; background: linear-gradient(transparent, #ffffff); pointer-events: none; }
.m-ws-open { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); height: 100%; font: 400 13px/1.45 var(--font-text); color: #232323; }
.m-ws-col { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.m-ws-col + .m-ws-col { border-left: 1px solid rgba(35, 35, 35, 0.1); background: #f8f9f8; }
.m-ws-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 10px; border-bottom: 1px solid rgba(35, 35, 35, 0.1); font-size: 12px; }
.m-leave-pill { font-family: var(--font-mono); font-size: 11px; padding: 3px 8px; border-radius: 6px; border: 1px solid rgba(35, 35, 35, 0.2); background: #ffffff; color: #232323; }
@media (min-width: 1024px) and (max-width: 1279px) {
  .app.ui { grid-template-columns: minmax(0, 4fr) minmax(0, 8fr); max-height: 410px; }
}
@media (max-width: 1023px) {
  .app.ui { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); max-height: 604px; margin-top: var(--s-6); }
  .app > .app__pane--list { max-height: 204px; }
  .app > .app__pane--list::after { display: none; }
  .app .ui-win__side { display: none; }
  .app .ui-win__body { grid-template-columns: minmax(0, 1fr); }
  .app > .app__pane + .app__pane { border-left: 0; border-top: 1px solid rgba(35, 35, 35, 0.1); }
  .m-ws-col { padding: 10px 14px; gap: 7px; }
  .m-ws-col .m-pod-vpeer:nth-of-type(3) { display: none; }
  .m-ws-col:first-child > .m-msg:last-child { display: none; }
}
@media (max-width: 639px) {
  .app.ui { grid-template-rows: minmax(0, 1fr); max-height: 440px; margin-top: var(--s-5); }
  .app > .app__pane--list { display: none; }
  .app > .app__pane + .app__pane { border-top: 0; }
  .m-ws-open { grid-template-columns: minmax(0, 1fr); }
  .m-ws-col + .m-ws-col { display: none; }
}
main > #how[data-moment="pinned-chapters"].is-live { display: block; }
main #how[data-moment="pinned-chapters"].is-live > .mo-pc__grid { flex: none; height: 100svh; }
.m-step-card { width: min(100%, 440px); background: #ffffff; color: #232323; border: 1px solid rgba(35, 35, 35, 0.14); border-radius: 12px; padding: 18px; display: grid; gap: 10px; font: 400 13px/1.45 var(--font-text); }
.m-step-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: 8px; background: #f3f3f3; font-size: 12px; }
.m-step-tag { font-family: var(--font-mono); font-size: 11px; padding: 2px 7px; border-radius: 6px; background: #a1ffcb; color: #232323; font-weight: 500; }
.m-step-tag--ink { background: #232323; color: #ffffff; }
@media (min-width: 640px) and (max-width: 1023px) {
  #how:not(.is-live) .mo-pc__steps { gap: var(--s-4); }
  #how:not(.is-live) .mo-pc__step { padding-top: var(--s-4); }
  #how:not(.is-live) .mo-pc__visual.mo-pc__visual--lit { aspect-ratio: auto; height: 196px; padding: 14px; }
  #how:not(.is-live) .m-step-card { padding: 12px; gap: 6px; }
  #how:not(.is-live) .m-step-row { padding: 5px 8px; }
}
@media (max-width: 639px) {
  main > #how[data-moment="pinned-chapters"]:not(.is-live) { min-height: 200vh; min-height: 200lvh; }
  main > #how[data-moment="pinned-chapters"]:not(.is-live) > .mo-pc__grid { height: 100%; align-content: space-between; }
  #how:not(.is-live) .mo-pc__steps { gap: var(--s-5); }
  #how:not(.is-live) .mo-pc__visual.mo-pc__visual--lit { aspect-ratio: auto; height: 288px; padding: 14px; }
}
#privacy .panel { --p-h: 272px; }
#privacy .ui-tg__sub, #privacy .ui-meta { color: #545454; }
.m-priv-points { margin-top: var(--s-6); }
.m-priv-pt { display: grid; gap: 6px; align-content: start; }
.m-priv-pt strong { font-size: 16px; font-weight: 500; color: #232323; }
.m-priv-pt p { font-size: 15px; line-height: 1.45; color: #232323; }
@media (min-width: 1024px) and (max-width: 1279px) {
  #privacy .section-head { margin-bottom: var(--s-5); }
  #privacy .panel { --p-h: 204px; }
  .m-priv-points { margin-top: var(--s-5); }
}
@media (min-width: 640px) and (max-width: 1023px) {
  #privacy .panel { --p-h: 284px; }
  .m-priv-points > .m-priv-pt { grid-column: auto / span 6; }
}
@media (max-width: 639px) {
  #privacy { --hm: 2; }
  #privacy > .wrap { justify-content: space-between; }
  #privacy .panel { --p-h: 248px; }
  .m-priv-points { margin-top: var(--s-5); row-gap: var(--s-4); }
}
.m-faq-audit {
  margin-top: var(--s-5);
  padding: 18px;
  border-radius: 12px;
  background: #f3f3f3;
  border: 1px solid rgba(35, 35, 35, 0.12);
  display: grid;
  gap: 8px;
  font: 400 12px/1.45 var(--font-mono);
  color: #232323;
}
.m-faq-audit__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 10px;
  border-radius: 6px;
  background: #ffffff;
  border: 1px solid rgba(35, 35, 35, 0.08);
}
@media (min-width: 640px) and (max-width: 1023px) {
  .m-faq-audit { padding: 12px 14px; gap: 6px; margin-top: var(--s-3); }
  .m-faq-audit__row { padding: 5px 8px; }
  .m-faq-audit__row.is-desk { display: none; }
}
@media (max-width: 639px) {
  #questions .section-head, #questions .stack-4 > * + * { margin-top: var(--s-2); }
  .m-faq-audit { padding: 10px 12px; gap: 5px; margin-top: var(--s-3); }
  .m-faq-audit__row { padding: 4px 8px; font-size: 11px; }
  .m-faq-audit__row.is-desk, .m-faq-audit__row.is-phone-hide { display: none; }
  #questions .faq > .faq__item { padding: 10px 0; gap: 4px; }
  #questions .faq > .faq__item:first-child { padding-top: 0; }
}
.close__word {
  line-height: 1.04;
  overflow: visible;
  font-size: clamp(64px, 19.5vw, 236px);
}
.m-close-facts {
  margin-top: auto;
  padding-top: var(--s-4);
}
@media (min-width: 640px) and (max-width: 1023px) {
  footer.closing > .wrap { row-gap: var(--s-6); }
  .closing__links { gap: var(--s-5); }
  .closing__links > .grid { row-gap: var(--s-5); }
}
@media (max-width: 639px) {
  .close__word { font-size: clamp(54px, 18vw, 88px); }
  .m-close-facts { display: none; }
}
`;

export default function LandingPage() {
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute('data-type', 'software');
    html.setAttribute('data-radius', 'soft');
    html.setAttribute('data-buttons', 'tonal');
    html.setAttribute('data-motion', 'on');
    html.setAttribute('data-ground', 'sky');
    html.classList.add('m-enter', 'mo-js');

    const enterTimer = window.setTimeout(() => {
      html.classList.add('m-enter-done');
    }, 700);
    const moTimer = window.setTimeout(() => {
      html.classList.add('mo-safe');
    }, 2500);

    const srcs = [
      '/assets/backgrounds/backgrounds.js',
      '/assets/system.js',
      '/assets/motion/motion.js',
      '/assets/layout/layout.js',
      '/assets/diagrams/mount.js',
    ];
    const added: HTMLScriptElement[] = [];
    for (const src of srcs) {
      if (document.querySelector(`script[src="${src}"]`)) continue;
      const s = document.createElement('script');
      if (src !== '/assets/backgrounds/backgrounds.js') {
        s.type = 'module';
      }
      s.src = src;
      document.body.appendChild(s);
      added.push(s);
    }

    return () => {
      window.clearTimeout(enterTimer);
      window.clearTimeout(moTimer);
      html.removeAttribute('data-type');
      html.removeAttribute('data-radius');
      html.removeAttribute('data-buttons');
      html.removeAttribute('data-motion');
      html.removeAttribute('data-ground');
      html.classList.remove('m-enter', 'm-enter-done', 'mo-js', 'mo-safe');
      for (const s of added) {
        s.remove();
      }
    };
  }, []);

  return (
    <div data-icon-base="/assets/icons">
      <link rel="stylesheet" href="/assets/system.css" />
      <link rel="stylesheet" href="/assets/ui/cards.css" />
      <link rel="stylesheet" href="/assets/motion/motion.css" />
      <link rel="stylesheet" href="/assets/backgrounds/backgrounds.css" />
      <link rel="stylesheet" href="/assets/layout/layout.css" />
      <link rel="stylesheet" href="/assets/icons/icon.css" />
      <link rel="stylesheet" href="/assets/ui/base.css" />
      <link rel="stylesheet" href="/assets/ui/window/fragment.css" />
      <link rel="stylesheet" href="/assets/ui/toggles/fragment.css" />
      <link rel="stylesheet" href="/assets/diagrams/diagram.css" />
      <style dangerouslySetInnerHTML={{ __html: LANDING_CSS }} />

      <header className="nav nav--centre">
        <div className="wrap nav__bar">
          <a className="skip-link" href="#top">
            Skip to content
          </a>
          <a className="nav__logo" href="#top">
            <span className="mark" data-mark="dots" aria-hidden="true" />
            Canopy
          </a>
          <nav className="nav__links" aria-label="Main">
            <div className="nav__item">
              <a className="nav__link" href="#rooms">
                Rooms
              </a>
            </div>
            <div className="nav__item">
              <a className="nav__link" href="#how">
                Matching
              </a>
            </div>
            <div className="nav__item">
              <a className="nav__link" href="#privacy">
                Privacy
              </a>
            </div>
            <div className="nav__item">
              <a className="nav__link" href="#questions">
                Questions
              </a>
            </div>
          </nav>
          <div className="nav__actions">
            <Link className="nav__link" href="/login">
              Sign in
            </Link>
            <Link className="btn btn--primary" href="/app">
              Open the dashboard
              <svg className="m-arrow" viewBox="0 0 12 12" aria-hidden="true">
                <path className="m-arrow__stem" d="M1 6h8" />
                <path className="m-arrow__head" d="M4.5 2.5 8 6l-3.5 3.5" />
              </svg>
            </Link>
          </div>
          <button
            className="nav__toggle"
            type="button"
            aria-expanded="false"
            aria-label="Menu"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path
                d="M2 5h14M2 13h14"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <main id="top">
        <section className="hero hero--split" data-enter aria-labelledby="hero-h">
          <div className="wrap">
            <div className="hero-text grid hero__grid">
              <div className="hero__text span-5">
                <p className="hero__kicker">
                  <span className="dot" aria-hidden="true" />
                  25 members per room, zero public profiles.
                </p>
                <h1 id="hero-h">Voice and chat rooms matched by interest</h1>
                <p className="hero__lead">
                  Pick a topic and join a 25-person democratic pod with threads, voice, and live Yes-or-No room votes, or run a Canopy Pro group with custom rules.
                </p>
                <div className="btn-row">
                  <Link className="btn btn--primary" href="/app">
                    Open the dashboard
                    <svg className="m-arrow" viewBox="0 0 12 12" aria-hidden="true">
                      <path className="m-arrow__stem" d="M1 6h8" />
                      <path className="m-arrow__head" d="M4.5 2.5 8 6l-3.5 3.5" />
                    </svg>
                  </Link>
                  <a className="btn btn--secondary" href="#how">
                    See how matching works
                  </a>
                </div>
              </div>

              <div className="hero__media span-6 start-7">
                <div
                  className="ui m-pod-win"
                  role="img"
                  aria-label="Room gaming-4821 showing 18 of 25 democratic seats, a live Pod Vote card, and Lounge Voice"
                >
                  <div className="m-pod-side" aria-hidden="true">
                    <div className="m-pod-head">
                      <span className="m-pod-code">#gaming-4821</span>
                      <span className="m-pod-cap">18/25</span>
                    </div>
                    <span className="m-pod-lbl">Text channels</span>
                    <span className="m-pod-ch is-active"># general</span>
                    <span className="m-pod-ch"># co-op-finder</span>
                    <span className="m-pod-ch"># patch-notes</span>
                    <span className="m-pod-lbl">Voice lounge</span>
                    <div className="m-pod-voice">
                      <strong style={{ fontSize: 12, fontWeight: 500 }}>
                        Lounge Voice
                      </strong>
                      <span className="m-pod-vpeer">
                        <i className="m-ring" />
                        Cobalt Fox
                      </span>
                      <span className="m-pod-vpeer">
                        <i className="m-ring" />
                        Amber Heron
                      </span>
                      <span className="m-pod-vpeer">
                        <i className="m-ring m-ring--idle" />
                        Slate Otter
                      </span>
                    </div>
                  </div>
                  <div className="m-pod-main" aria-hidden="true">
                    <div className="m-pod-bar">
                      <span>
                        <strong>#gaming-4821</strong> &middot;{' '}
                        <span className="mono">18/25 &middot; Democratic</span>
                      </span>
                      <span className="mono" style={{ color: '#545454' }}>
                        Cobalt Fox
                      </span>
                    </div>
                    <div className="m-pod-feed">
                      <div className="m-msg">
                        <div className="m-msg__top">
                          <span className="m-alias">Cobalt Fox</span>
                          <span className="m-time">21:14</span>
                        </div>
                        <div className="m-msg__body">
                          Anyone free for two co-op missions at 22:00 UTC?
                        </div>
                        <span className="m-thread-chip">
                          3 replies in thread &middot; last 1m ago
                        </span>
                      </div>
                      <div className="m-msg">
                        <div className="m-msg__top">
                          <span className="m-alias m-alias--amber">Amber Heron</span>
                          <span className="m-time">21:15 &middot; Pod Vote</span>
                        </div>
                        <div className="m-poll-box">
                          <div className="m-poll-q">
                            Add #builds-and-clips? &middot; 11 Yes &middot; 2 No
                          </div>
                          <div className="m-poll-opt is-lead">
                            <span>Vote Yes (Yes &gt; No wins)</span>
                            <span className="mono">11 Yes</span>
                          </div>
                          <div className="m-poll-opt">
                            <span>Vote No</span>
                            <span className="mono">2 No</span>
                          </div>
                        </div>
                      </div>
                      <div className="m-msg">
                        <div className="m-msg__top">
                          <span className="m-alias m-alias--slate">Slate Otter</span>
                          <span className="m-time">21:16</span>
                        </div>
                        <div className="m-msg__body">
                          Voted Yes on #builds-and-clips. Jumping into Lounge Voice now.
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="ly-float">
                  <div className="ly-float__row">
                    <span className="ly-live">Lounge Voice</span>
                    <span>18/25 &middot; Democratic</span>
                  </div>
                  <div className="ly-float__title">
                    Pod Vote: Add #builds-and-clips? &middot; 11 Yes &middot; 2 No
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="rooms" aria-labelledby="rooms-h">
          <div className="wrap">
            <div className="grid">
              <div className="span-5">
                <h2 id="rooms-h">Democratic rooms and Pro groups</h2>
              </div>
              <div className="span-6 start-7 stack-4">
                <p className="t-lead">
                  Every 25-member pod votes Yes or No to add channels, edit rules, or remove disruptive peers. Canopy Pro hosts owner-run custom groups.
                </p>
                <p>
                  <a className="link" href="#privacy">
                    Read the privacy boundary
                  </a>
                </p>
              </div>
            </div>

            <div
              className="ui app fill"
              role="img"
              aria-label="Canopy workspace showing 25-member democratic pods, a live Pod Vote card, Pro custom groups, and open side thread"
            >
              <div className="app__pane app__pane--list">
                <div
                  className="ui ui-panel ui-win"
                  data-ui="window"
                  data-ui-still=""
                  data-open="Active"
                  data-work="Voice"
                  data-done="Online"
                >
                  <div className="ui-win__bar">
                    <span className="ui-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className="ui-win__crumb">
                      <b>Canopy</b> <i>/</i> Democratic &amp; Pro pods
                    </span>
                    <span className="ui-spacer" />
                    <span className="ui-win__search" aria-hidden="true">
                      <svg className="ui-icon" viewBox="0 0 16 16">
                        <circle cx="7" cy="7" r="4.5" />
                        <path d="m10.5 10.5 3 3" />
                      </svg>
                      <span className="ui-win__ph">Search</span>
                      <span className="ui-kbd">/</span>
                    </span>
                  </div>
                  <div className="ui-win__body">
                    <nav className="ui-win__side" aria-hidden="true">
                      <span className="ui-win__nav is-on">
                        <span className="ui-win__hash">#</span>Gaming<em>18/25</em>
                      </span>
                      <span className="ui-win__nav">
                        <span className="ui-win__hash">#</span>Chess<em>21/25</em>
                      </span>
                      <span className="ui-win__nav">
                        <span className="ui-win__hash">#</span>Synths<em>14/25</em>
                      </span>
                      <span className="ui-win__nav">
                        <span className="ui-win__hash">#</span>Raiders<em>12/25</em>
                      </span>
                      <span className="ui-win__label">Channels</span>
                      <span className="ui-win__nav">
                        <span className="ui-win__hash">#</span>general
                      </span>
                      <span className="ui-win__nav">
                        <span className="ui-win__hash">#</span>co-op-finder
                      </span>
                      <span className="ui-win__nav">
                        <span className="ui-win__hash">#</span>Lounge Voice
                      </span>
                    </nav>
                    <div className="ui-win__main">
                      <div className="ui-win__cols" aria-hidden="true">
                        <span>Alias</span>
                        <span>Activity</span>
                        <span>State</span>
                        <span>Pod</span>
                      </div>
                      <ul className="ui-win__rows">
                        <li className="ui-win__row" data-row="">
                          <span className="ui-avatar" data-tone="3">CF</span>
                          <span className="ui-win__who">Cobalt Fox</span>
                          <span className="ui-win__sub">Speaking in Lounge Voice</span>
                          <span className="ui-win__st" data-st="">Voice</span>
                          <span className="ui-win__age">#4821</span>
                        </li>
                        <li className="ui-win__row" data-row="">
                          <span className="ui-avatar" data-tone="2">AH</span>
                          <span className="ui-win__who">Amber Heron</span>
                          <span className="ui-win__sub">Proposed #builds</span>
                          <span className="ui-win__st" data-st="">Vote</span>
                          <span className="ui-win__age">#4821</span>
                        </li>
                        <li className="ui-win__row" data-row="">
                          <span className="ui-avatar" data-tone="4">SO</span>
                          <span className="ui-win__who">Slate Otter</span>
                          <span className="ui-win__sub">Replied in #general</span>
                          <span className="ui-win__st" data-st="">Active</span>
                          <span className="ui-win__age">#4821</span>
                        </li>
                        <li className="ui-win__row" data-row="">
                          <span className="ui-avatar" data-tone="1">MO</span>
                          <span className="ui-win__who">Mint Owl</span>
                          <span className="ui-win__sub">Voted Yes on #4821</span>
                          <span className="ui-win__st is-done" data-st="">Online</span>
                          <span className="ui-win__age">#4821</span>
                        </li>
                        <li className="ui-win__row" data-row="">
                          <span className="ui-avatar" data-tone="5">CP</span>
                          <span className="ui-win__who">Cedar Pike</span>
                          <span className="ui-win__sub">Shared audio (4.2s)</span>
                          <span className="ui-win__st is-done" data-st="">Online</span>
                          <span className="ui-win__age">#4821</span>
                        </li>
                        <li className="ui-win__row" data-row="">
                          <span className="ui-avatar" data-tone="3">BL</span>
                          <span className="ui-win__who">Birch Lynx</span>
                          <span className="ui-win__sub">Voted Yes (11 / 2)</span>
                          <span className="ui-win__st is-done" data-st="">Online</span>
                          <span className="ui-win__age">#4821</span>
                        </li>
                        <li className="ui-win__row" data-row="">
                          <span className="ui-avatar" data-tone="2">RF</span>
                          <span className="ui-win__who">Reed Finch</span>
                          <span className="ui-win__sub">Listed Pro group</span>
                          <span className="ui-win__st is-done" data-st="">Pro</span>
                          <span className="ui-win__age">#1094</span>
                        </li>
                        <li className="ui-win__row" data-row="">
                          <span className="ui-avatar" data-tone="4">DW</span>
                          <span className="ui-win__who">Dune Wren</span>
                          <span className="ui-win__sub">Uploaded synth patch</span>
                          <span className="ui-win__st is-done" data-st="">Online</span>
                          <span className="ui-win__age">#2910</span>
                        </li>
                        <li className="ui-win__row" data-row="">
                          <span className="ui-avatar" data-tone="1">KM</span>
                          <span className="ui-win__who">Kelp Marten</span>
                          <span className="ui-win__sub">Joined Lounge Voice</span>
                          <span className="ui-win__st" data-st="">Voice</span>
                          <span className="ui-win__age">#2910</span>
                        </li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              <div className="app__pane app__pane--open">
                <div className="m-ws-open" aria-hidden="true">
                  <div className="m-ws-col">
                    <div className="m-ws-head">
                      <span>
                        <strong>#gaming-4821</strong> &middot; 18/25 &middot; Democratic
                      </span>
                      <span className="m-leave-pill">Leave pod</span>
                    </div>
                    <div className="m-msg">
                      <div className="m-msg__top">
                        <span className="m-alias">Cobalt Fox</span>
                        <span className="m-time">21:14</span>
                      </div>
                      <div className="m-msg__body">
                        Queued two co-op drops. Drop loadouts in the thread so main chat stays clean.
                      </div>
                      <span className="m-thread-chip">Thread &middot; 3 replies</span>
                    </div>
                    <div className="m-msg">
                      <div className="m-msg__top">
                        <span className="m-alias m-alias--amber">Amber Heron</span>
                        <span className="m-time">21:15 &middot; Pod Vote</span>
                      </div>
                      <div className="m-poll-box">
                        <div className="m-poll-q">
                          Add #builds-and-clips? &middot; 11 Yes &middot; 2 No
                        </div>
                        <div className="m-poll-opt is-lead">
                          <span>Yes &middot; Cobalt Fox, Birch Lynx +9</span>
                          <span className="mono">11 Yes</span>
                        </div>
                        <div className="m-poll-opt">
                          <span>No &middot; Slate Otter, Cedar Pike</span>
                          <span className="mono">2 No</span>
                        </div>
                        <div className="m-poll-opt">
                          <span>Rule: Yes &gt; No wins &middot; 5 remaining</span>
                          <span className="mono">Open</span>
                        </div>
                      </div>
                    </div>
                    <div className="m-msg">
                      <div className="m-msg__top">
                        <span className="m-alias m-alias--slate">Slate Otter</span>
                        <span className="m-time">21:18</span>
                      </div>
                      <div className="m-msg__body">
                        Voted on the channel proposal. Jumping into Lounge Voice now.
                      </div>
                    </div>
                  </div>

                  <div className="m-ws-col">
                    <div className="m-ws-head">
                      <strong>Thread &middot; #general</strong>
                      <span className="mono" style={{ color: '#545454' }}>
                        3 replies
                      </span>
                    </div>
                    <div className="m-msg">
                      <div className="m-msg__top">
                        <span className="m-alias m-alias--slate">Slate Otter</span>
                        <span className="m-time">21:15</span>
                      </div>
                      <div className="m-msg__body">
                        Bringing medic kit and smoke grenades for mission one.
                      </div>
                    </div>
                    <div className="m-msg">
                      <div className="m-msg__top">
                        <span className="m-alias">Mint Owl</span>
                        <span className="m-time">21:16</span>
                      </div>
                      <div className="m-msg__body">
                        I can run anti-tank + supply pack. Ready in 5 minutes.
                      </div>
                    </div>
                    <div className="m-msg">
                      <div className="m-msg__top">
                        <span className="m-alias">Cobalt Fox</span>
                        <span className="m-time">21:17</span>
                      </div>
                      <div className="m-msg__body">
                        Locked. Meet in Lounge Voice, 3 peers on mic right now.
                      </div>
                    </div>
                    <div className="m-pod-voice" style={{ marginTop: 8 }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <strong style={{ fontSize: 12, fontWeight: 500 }}>
                          Lounge Voice (WebRTC)
                        </strong>
                        <span
                          className="mono"
                          style={{ fontSize: 11, color: '#1f6b3a' }}
                        >
                          Live
                        </span>
                      </div>
                      <span className="m-pod-vpeer">
                        <i className="m-ring" />
                        Cobalt Fox &middot; speaking
                      </span>
                      <span className="m-pod-vpeer">
                        <i className="m-ring" />
                        Amber Heron &middot; speaking
                      </span>
                      <span className="m-pod-vpeer">
                        <i className="m-ring m-ring--idle" />
                        Slate Otter &middot; connected
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section
          className="section"
          id="how"
          style={{ ['--h' as string]: 2 }}
          data-moment="pinned-chapters"
          aria-labelledby="how-h"
        >
          <div className="wrap mo-pc__grid">
            <div className="mo-pc__text">
              <h2 id="how-h">How room matching works</h2>
              <ol className="mo-pc__steps">
                <li className="mo-pc__step">
                  <h3>Verify 1 account, keep rooms anonymous</h3>
                  <p>
                    Sign up once with your account details. Canopy locks your name, gender, and nationality inside authentication so room payloads hold zero personal fields.
                  </p>
                  <figure className="mo-pc__visual mo-pc__visual--lit">
                    <div
                      className="ui m-step-card"
                      role="img"
                      aria-label="Private account vault separated from blind room alias"
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <strong>Account verification vault</strong>
                        <span className="m-step-tag m-step-tag--ink">Private</span>
                      </div>
                      <div className="m-step-row">
                        <span>Full name &amp; email</span>
                        <span className="mono">Auth table only</span>
                      </div>
                      <div className="m-step-row">
                        <span>Gender &amp; nationality</span>
                        <span className="mono">Never in match SQL</span>
                      </div>
                      <div
                        className="m-step-row"
                        style={{ background: '#e9f9ef' }}
                      >
                        <span>Room identity</span>
                        <span className="m-step-tag">Cobalt Fox &middot; p_9f81a2</span>
                      </div>
                    </div>
                  </figure>
                </li>
                <li className="mo-pc__step">
                  <h3>Vote Yes or No in 25-member rooms</h3>
                  <p>
                    Join a 25-seat pod where adding channels, editing rules, or kicking a disruptive peer runs on a Yes-or-No vote (Yes &gt; No wins), never one moderator.
                  </p>
                  <figure className="mo-pc__visual mo-pc__visual--lit">
                    <div
                      className="ui m-step-card"
                      role="img"
                      aria-label="Democratic 25-member pod with live Yes versus No proposal vote"
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <strong>#gaming-4821 &middot; Democratic</strong>
                        <span className="m-step-tag">18 / 25</span>
                      </div>
                      <div className="m-step-row">
                        <span>Add #builds-and-clips?</span>
                        <span className="mono">11 Yes &middot; 2 No</span>
                      </div>
                      <div className="m-step-row">
                        <span>Decision rule</span>
                        <span className="mono">Yes &gt; No wins</span>
                      </div>
                      <div className="m-step-row">
                        <span>Your room alias</span>
                        <span
                          className="mono"
                          style={{ color: '#1f6b3a', fontWeight: 500 }}
                        >
                          Cobalt Fox
                        </span>
                      </div>
                    </div>
                  </figure>
                </li>
                <li className="mo-pc__step">
                  <h3>Run a Canopy Pro group or rematch</h3>
                  <p>
                    Preselect your room name and admin rules on Canopy Pro, private by invite link or listed in the directory, 100% blind to names, genders, and nationalities.
                  </p>
                  <figure className="mo-pc__visual mo-pc__visual--lit">
                    <div
                      className="ui m-step-card"
                      role="img"
                      aria-label="Canopy Pro custom group settings kept blind to personal identity"
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <strong>#tactical-raiders &middot; Pro Admin</strong>
                        <span className="m-step-tag">12 / 25</span>
                      </div>
                      <div className="m-step-row">
                        <span>Governance</span>
                        <span className="mono">Owner &amp; Admin rights</span>
                      </div>
                      <div className="m-step-row">
                        <span>Visibility</span>
                        <span className="mono">Invite link or Directory</span>
                      </div>
                      <div className="m-step-row">
                        <span>Member identity</span>
                        <span className="m-step-tag m-step-tag--ink">
                          0 personal fields
                        </span>
                      </div>
                    </div>
                  </figure>
                </li>
              </ol>
              <p>
                <Link className="link" href="/app">
                  Open a matched room
                </Link>
              </p>
            </div>
            <div className="mo-pc__visuals frame" />
          </div>
        </section>

        <section className="section" id="privacy" aria-labelledby="privacy-h">
          <div className="wrap">
            <div className="section-head">
              <h2 id="privacy-h">
                Account privacy and blind rooms.{' '}
                <span className="muted">Identity stays out of chat.</span>
              </h2>
            </div>
            <div className="grid">
              <article className="card card--row card--open m-nolift span-6">
                <h3>Locks personal fields outside rooms</h3>
                <p>
                  Name, email, gender, and nationality stay outside room payloads.
                </p>
                <div className="panel">
                  <div className="dg" data-diagram="" data-dg-still="">
                    <script
                      type="application/json"
                      dangerouslySetInnerHTML={{ __html: DIAGRAM_SPEC }}
                    />
                  </div>
                </div>
              </article>

              <article className="card card--row card--open m-nolift span-6">
                <h3>Assigns a fresh alias per room</h3>
                <p>
                  Hold Cobalt Fox in gaming and Mint Owl in chess.
                </p>
                <div className="panel">
                  <div className="stage">
                    <div
                      className="at-right"
                      style={{
                        ['--ax' as string]: '28px',
                        ['--ay' as string]: '26px',
                      }}
                      data-ui-still=""
                    >
                      <div className="ui ui-panel ui-toggles" data-ui="toggles">
                        <div className="ui-head">
                          <svg
                            className="ui-icon ui-toggles__ico"
                            viewBox="0 0 16 16"
                            aria-hidden="true"
                          >
                            <path d="M8 1.8 13 4v3.6c0 3-2.1 5.4-5 6.6-2.9-1.2-5-3.6-5-6.6V4z" />
                            <path d="m5.8 8 1.6 1.6 3-3.2" />
                          </svg>
                          <div className="ui-title">Blind pod guardrails</div>
                          <span className="ui-spacer" />
                          <div className="ui-meta" data-tg-count="">
                            3 of 3 on
                          </div>
                        </div>
                        <ul className="ui-toggles__list">
                          <li className="ui-tg">
                            <span className="ui-tg__text">
                              <span className="ui-tg__label">
                                Strip real name and email
                              </span>
                              <span className="ui-tg__sub">
                                Kept in /api/auth/me only
                              </span>
                            </span>
                            <button
                              className="ui-switch is-on"
                              type="button"
                              role="switch"
                              aria-checked="true"
                              aria-label="Strip real name and email"
                            >
                              <i />
                            </button>
                          </li>
                          <li className="ui-tg">
                            <span className="ui-tg__text">
                              <span className="ui-tg__label">
                                Mint per-room animal alias
                              </span>
                              <span className="ui-tg__sub">
                                Unique in every pod
                              </span>
                            </span>
                            <button
                              className="ui-switch is-on"
                              type="button"
                              role="switch"
                              aria-checked="true"
                              aria-label="Mint per-room animal alias"
                            >
                              <i />
                            </button>
                          </li>
                          <li className="ui-tg">
                            <span className="ui-tg__text">
                              <span className="ui-tg__label">
                                Skip demographic filters
                              </span>
                              <span className="ui-tg__sub">
                                Matches by interest slug
                              </span>
                            </span>
                            <button
                              className="ui-switch is-on"
                              type="button"
                              role="switch"
                              aria-checked="true"
                              aria-label="Skip demographic filters"
                            >
                              <i />
                            </button>
                          </li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            </div>

            <div className="grid m-priv-points">
              <div className="m-priv-pt span-3">
                <strong>Private account lock</strong>
                <p>Sign-up fields stay in your login.</p>
              </div>
              <div className="m-priv-pt span-3">
                <strong>Democratic Yes/No votes</strong>
                <p>25-seat pods vote Yes over No.</p>
              </div>
              <div className="m-priv-pt span-3">
                <strong>Canopy Pro groups</strong>
                <p>Run custom rooms by invite or directory.</p>
              </div>
              <div className="m-priv-pt span-3">
                <strong>One-click opt-out</strong>
                <p>Leaving records pod_opt_outs before rematching.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="questions" aria-labelledby="questions-h">
          <div className="wrap grid grid--top">
            <div className="span-5 stack-4">
              <h2 id="questions-h">Questions</h2>
              <p className="t-lead">
                25-seat democratic pods, Pro groups, and blind chat.
              </p>
              <p>
                <Link className="link" href="/register">
                  Create a verified account
                </Link>
              </p>
              <div
                className="ui m-faq-audit"
                role="img"
                aria-label="Room WebSocket payload showing 18 of 25 democratic governance, alias, and zero personal fields"
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontFamily: 'var(--font-text)',
                    fontWeight: 500,
                    fontSize: 13,
                  }}
                >
                  <span>Live room frame (#gaming-4821)</span>
                  <span className="m-step-tag">0 PII fields</span>
                </div>
                <div className="m-faq-audit__row">
                  <span>governanceMode</span>
                  <span>&quot;DEMOCRATIC&quot; (18/25)</span>
                </div>
                <div className="m-faq-audit__row">
                  <span>senderAlias</span>
                  <span>&quot;Cobalt Fox&quot;</span>
                </div>
                <div className="m-faq-audit__row">
                  <span>fullName / email</span>
                  <span style={{ color: '#1f6b3a', fontWeight: 500 }}>
                    omitted
                  </span>
                </div>
                <div className="m-faq-audit__row is-phone-hide">
                  <span>gender / nationality</span>
                  <span style={{ color: '#1f6b3a', fontWeight: 500 }}>
                    omitted
                  </span>
                </div>
                <div className="m-faq-audit__row is-desk">
                  <span>userId / publicId</span>
                  <span style={{ color: '#1f6b3a', fontWeight: 500 }}>
                    omitted
                  </span>
                </div>
                <div className="m-faq-audit__row is-desk">
                  <span>proposalRule</span>
                  <span style={{ color: '#1f6b3a', fontWeight: 500 }}>
                    yesCount &gt; noCount
                  </span>
                </div>
                <div className="m-faq-audit__row is-desk">
                  <span>proCustomGroups</span>
                  <span style={{ color: '#1f6b3a', fontWeight: 500 }}>
                    zero PII
                  </span>
                </div>
              </div>
            </div>

            <div className="faq span-6 start-7">
              <div className="faq__item">
                <h3>How do 25-member rooms vote?</h3>
                <p>
                  Adding channels, editing rules, or kicking peers runs on a Yes-or-No vote (Yes &gt; No wins).
                </p>
              </div>
              <div className="faq__item">
                <h3>What do Canopy Pro groups add?</h3>
                <p>
                  Set custom room names and admin rules, shared by invite link or public directory.
                </p>
              </div>
              <div className="faq__item">
                <h3>Can room admins see my real name?</h3>
                <p>
                  No. Democratic and Pro rooms hide name, email, gender, and nationality behind an alias.
                </p>
              </div>
              <div className="faq__item">
                <h3>What happens when I leave a room?</h3>
                <p>
                  Canopy saves a pod opt-out and rematches you into an open 25-seat pod.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer closing" id="contact" aria-labelledby="close-h">
        <div className="wrap">
          <div className="closing__cta close--word">
            <div className="section-head--split">
              <div>
                <h2 id="close-h">Match into your first room</h2>
                <p className="t-lead">
                  25 seats per room, Yes-or-No member votes, zero public profiles.
                </p>
              </div>
              <Link className="btn btn--primary" href="/app">
                Open the dashboard
                <svg className="m-arrow" viewBox="0 0 12 12" aria-hidden="true">
                  <path className="m-arrow__stem" d="M1 6h8" />
                  <path className="m-arrow__head" d="M4.5 2.5 8 6l-3.5 3.5" />
                </svg>
              </Link>
            </div>
            <dl className="stats m-close-facts">
              <div>
                <dt className="t-small muted">Default room size</dt>
                <dd className="t-stat">25 seats</dd>
              </div>
              <div>
                <dt className="t-small muted">Pod governance</dt>
                <dd className="t-stat">Yes &gt; No</dd>
              </div>
              <div>
                <dt className="t-small muted">Personal fields in rooms</dt>
                <dd className="t-stat">0 exposed</dd>
              </div>
            </dl>
            <p className="close__word" aria-hidden="true">
              Canopy
            </p>
          </div>

          <div className="closing__links">
            <div className="grid">
              <div className="span-6 stack-4">
                <a className="nav__logo" href="#top">
                  <span className="mark" data-mark="dots" aria-hidden="true" />
                  Canopy
                </a>
                <p className="footer__lede">
                  Interest-matched voice and chat rooms.
                </p>
              </div>
              <div className="span-3 start-7 footer__col">
                <h3>Product</h3>
                <ul>
                  <li>
                    <Link href="/app">Rooms and voice</Link>
                  </li>
                  <li>
                    <a href="#how">How matching works</a>
                  </li>
                  <li>
                    <a href="#privacy">Privacy boundary</a>
                  </li>
                </ul>
              </div>
              <div className="span-3 footer__col">
                <h3>Support</h3>
                <ul>
                  <li>
                    <Link href="/register">Create account</Link>
                  </li>
                  <li>
                    <Link href="/login">Sign in</Link>
                  </li>
                  <li>
                    <Link href="/register?fresh=1">New isolated tab</Link>
                  </li>
                </ul>
              </div>
            </div>
            <div className="footer__legal">
              <span>
                &copy; 2026 Canopy &nbsp; <Link href="/privacy">Privacy</Link>{' '}
                &nbsp; <Link href="/terms">Terms</Link>
              </span>
              <div className="socials" />
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

'use client';

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
import ui from './ui.module.css';

// The native <dialog> gives the focus trap, Escape, and an inert page behind it.
export function Dialog({
  title,
  lead,
  width = 560,
  onClose,
  children,
  foot,
  bare = false,
}: {
  title: ReactNode;
  lead?: ReactNode;
  width?: number;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
  // The children bring their own body and footer.
  bare?: boolean;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) el.showModal();
    el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => el.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className={`${ui.dialog} ${bare ? ui.tall : ''}`}
      style={{ '--w': `${width}px` } as CSSProperties}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={ui.sheet}>
        <header className={ui.head}>
          <div>
            <h2 id={titleId}>{title}</h2>
            {lead && <p>{lead}</p>}
          </div>
          <button type="button" className={ui.icon} onClick={onClose} aria-label="Close">
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        {bare ? children : <div className={ui.body}>{children}</div>}
        {foot && <footer className={ui.foot}>{foot}</footer>}
      </div>
    </dialog>
  );
}

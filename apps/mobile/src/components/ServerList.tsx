import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { SavedServerProfile } from "../connections/store";
import { hapticTick } from "../haptics";
import type { Translator } from "../i18n";

const HOLD_TO_REORDER_MS = 280;
const SCROLL_EDGE = 72;

interface DragState {
  readonly id: string;
  readonly pointerId: number;
  readonly timer: number;
  readonly anchorY: number;
  active: boolean;
}

interface ServerListProps {
  readonly profiles: readonly SavedServerProfile[];
  readonly busyId: string | null;
  readonly onConnect: (id: string) => void;
  readonly onEdit: (profile: SavedServerProfile) => void;
  readonly onForget: (profile: SavedServerProfile) => void;
  readonly onMove: (id: string, index: number) => void;
  readonly t: Translator;
}

export function ServerList(props: ServerListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const positions = useRef(new Map<string, number>());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const t = props.t;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(
    () => () => {
      if (dragRef.current) clearTimeout(dragRef.current.timer);
    },
    [],
  );

  useLayoutEffect(() => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-server-row]") ?? [];
    for (const row of rows) {
      const id = row.dataset.serverId;
      if (!id) continue;
      const next = row.getBoundingClientRect().top;
      const previous = positions.current.get(id);
      if (
        previous !== undefined &&
        Math.abs(previous - next) > 1 &&
        id !== draggingId &&
        !reducedMotion
      ) {
        row.animate(
          [{ transform: `translateY(${previous - next}px)` }, { transform: "translateY(0)" }],
          { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      }
      positions.current.set(id, next);
    }
  });

  if (props.profiles.length === 0) {
    return (
      <div className="empty-state">
        <h3>{t("noServersTitle")}</h3>
        <p>{t("noServersBody")}</p>
      </div>
    );
  }

  const rows = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-server-row]") ?? []);

  const targetIndex = (clientY: number): number => {
    for (const [index, row] of rows().entries()) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return index;
    }
    return Math.max(0, rows().length - 1);
  };

  const placeDragged = (clientY: number) => {
    const drag = dragRef.current;
    if (!drag?.active) return;
    const card = listRef.current?.querySelector<HTMLElement>(
      `[data-server-id="${CSS.escape(drag.id)}"] .server-card`,
    );
    if (!card) return;
    const current = Number.parseFloat(card.style.getPropertyValue("--drag-dy") || "0");
    const layoutTop = card.getBoundingClientRect().top - current;
    card.style.setProperty("--drag-dy", `${clientY - drag.anchorY - layoutTop}px`);
  };

  const autoScroll = (clientY: number) => {
    if (clientY < SCROLL_EDGE) window.scrollBy(0, -14);
    else if (clientY > window.innerHeight - SCROLL_EDGE) window.scrollBy(0, 14);
  };

  const cardOf = (node: HTMLElement) => node.closest<HTMLElement>(".server-card");

  const startDrag = (event: PointerEvent<HTMLElement>, id: string) => {
    if (event.button !== 0 || props.busyId !== null || props.profiles.length < 2) return;
    const card = cardOf(event.currentTarget);
    const top = card?.getBoundingClientRect().top ?? event.clientY;
    const timer = window.setTimeout(() => {
      if (dragRef.current?.id !== id) return;
      dragRef.current.active = true;
      suppressClick.current = true;
      setMenuId(null);
      setDraggingId(id);
      hapticTick();
    }, HOLD_TO_REORDER_MS);
    dragRef.current = {
      id,
      pointerId: event.pointerId,
      timer,
      anchorY: event.clientY - top,
      active: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      const card = cardOf(event.currentTarget);
      const top = card?.getBoundingClientRect().top ?? event.clientY;
      if (Math.abs(event.clientY - (top + drag.anchorY)) > 10) {
        clearTimeout(drag.timer);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        dragRef.current = null;
      }
      return;
    }
    event.preventDefault();
    placeDragged(event.clientY);
    autoScroll(event.clientY);
    const next = targetIndex(event.clientY);
    const current = props.profiles.findIndex((profile) => profile.id === drag.id);
    if (current >= 0 && next !== current) {
      props.onMove(drag.id, next);
      hapticTick();
    }
  };

  const finishDrag = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    clearTimeout(drag.timer);
    if (commit && drag.active) props.onMove(drag.id, targetIndex(event.clientY));
    cardOf(event.currentTarget)?.style.removeProperty("--drag-dy");
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDraggingId(null);
  };

  return (
    <ul className="server-list" ref={listRef}>
      {props.profiles.map((profile, index) => {
        const menuOpen = menuId === profile.id;
        return (
          <li key={profile.id} data-server-row data-server-id={profile.id}>
            <article
              className="server-card"
              data-dragging={draggingId === profile.id ? "true" : undefined}
              aria-busy={props.busyId === profile.id}
            >
              <button
                type="button"
                className="server-card-main"
                aria-label={t("connect")}
                disabled={props.busyId !== null}
                data-connecting={props.busyId === profile.id ? "true" : undefined}
                onPointerDown={(event) => startDrag(event, profile.id)}
                onPointerMove={moveDrag}
                onPointerUp={(event) => finishDrag(event, true)}
                onPointerCancel={(event) => finishDrag(event, false)}
                onContextMenu={(event) => event.preventDefault()}
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  setMenuId(null);
                  props.onConnect(profile.id);
                }}
              >
                <span className="server-identity">
                  <h3>{profile.label}</h3>
                  <span className="server-origin" title={profile.pinnedEnvironmentId}>
                    {profile.origin}
                  </span>
                </span>
                <span className="badge-row">
                  <span
                    className={`badge ${profile.origin.startsWith("http://") ? "badge-warning" : "badge-safe"}`}
                  >
                    {profile.origin.startsWith("http://") ? t("httpOptIn") : t("https")}
                  </span>
                  <span
                    className={`badge ${profile.healthStatus === "verified" ? "badge-safe" : profile.healthStatus === "unverified" ? "" : "badge-danger"}`}
                    data-testid="health-badge"
                  >
                    {t(profile.healthStatus)}
                  </span>
                  {profile.hasSavedPassword ? (
                    <span className="badge">{t("vaultSaved")}</span>
                  ) : null}
                </span>
                <span className="server-connect-state">
                  {props.busyId === profile.id ? t("connectingServer") : t("connect")}
                </span>
              </button>
              <div className="server-card-tools">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t("serverActions")}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  disabled={props.busyId !== null}
                  onClick={() => setMenuId(menuOpen ? null : profile.id)}
                >
                  ···
                </button>
                {menuOpen ? (
                  <div className="server-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => props.onEdit(profile)}>
                      {t("edit")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={index === 0}
                      onClick={() => props.onMove(profile.id, index - 1)}
                    >
                      {t("moveUp")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={index === props.profiles.length - 1}
                      onClick={() => props.onMove(profile.id, index + 1)}
                    >
                      {t("moveDown")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="server-menu-danger"
                      onClick={() => {
                        setMenuId(null);
                        props.onForget(profile);
                      }}
                    >
                      {t("forget")}
                    </button>
                  </div>
                ) : null}
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

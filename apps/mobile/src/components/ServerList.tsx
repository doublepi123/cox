import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { SavedServerProfile } from "../connections/store";
import type { Translator } from "../i18n";

const HOLD_TO_REORDER_MS = 360;

interface DragState {
  readonly id: string;
  readonly pointerId: number;
  readonly timer: number;
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
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const t = props.t;

  useEffect(
    () => () => {
      if (dragRef.current) clearTimeout(dragRef.current.timer);
    },
    [],
  );

  if (props.profiles.length === 0) {
    return (
      <div className="empty-state">
        <h3>{t("noServersTitle")}</h3>
        <p>{t("noServersBody")}</p>
      </div>
    );
  }

  const targetIndex = (clientY: number): number => {
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-server-row]") ?? [],
    );
    for (const [index, row] of rows.entries()) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return index;
    }
    return Math.max(0, rows.length - 1);
  };

  const startDrag = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0 || props.busyId !== null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const timer = window.setTimeout(() => {
      if (dragRef.current?.id !== id) return;
      dragRef.current.active = true;
      setDraggingId(id);
    }, HOLD_TO_REORDER_MS);
    dragRef.current = { id, pointerId: event.pointerId, timer, active: false };
  };

  const finishDrag = (event: PointerEvent<HTMLButtonElement>, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    clearTimeout(drag.timer);
    if (commit && drag.active) props.onMove(drag.id, targetIndex(event.clientY));
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDraggingId(null);
  };

  return (
    <ul className="server-list" ref={listRef}>
      {props.profiles.map((profile, index) => (
        <li key={profile.id} data-server-row>
          <article
            className="server-card"
            data-dragging={draggingId === profile.id ? "true" : undefined}
            aria-busy={props.busyId === profile.id}
          >
            <div className="server-card-heading">
              <div className="server-identity">
                <h3>{profile.label}</h3>
                <p className="server-origin">{profile.origin}</p>
              </div>
              <button
                type="button"
                className="button button-ghost drag-handle"
                aria-label={`${t("holdToReorder")}: ${profile.label}`}
                disabled={props.profiles.length < 2 || props.busyId !== null}
                onPointerDown={(event) => startDrag(event, profile.id)}
                onPointerMove={(event) => {
                  if (dragRef.current?.active) event.preventDefault();
                }}
                onPointerUp={(event) => finishDrag(event, true)}
                onPointerCancel={(event) => finishDrag(event, false)}
                onContextMenu={(event) => event.preventDefault()}
              >
                {t("holdToReorder")}
              </button>
            </div>
            <div className="badge-row" aria-label={t("savedServers")}>
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
              {profile.hasSavedPassword ? <span className="badge">{t("vaultSaved")}</span> : null}
            </div>
            <dl className="server-metadata">
              <div>
                <dt>{t("serverVersion")}</dt>
                <dd>{profile.lastServerVersion}</dd>
              </div>
              <div>
                <dt>{t("environment")}</dt>
                <dd title={profile.pinnedEnvironmentId}>
                  {profile.pinnedEnvironmentId.slice(0, 12)}
                </dd>
              </div>
            </dl>
            <div className="server-actions">
              <button
                type="button"
                className="button button-secondary connect-button"
                disabled={props.busyId !== null}
                onClick={() => props.onConnect(profile.id)}
              >
                {t("connect")}
              </button>
              <button
                type="button"
                className="button button-ghost"
                disabled={index === 0 || props.busyId !== null}
                onClick={() => props.onMove(profile.id, index - 1)}
              >
                {t("moveUp")}
              </button>
              <button
                type="button"
                className="button button-ghost"
                disabled={index === props.profiles.length - 1 || props.busyId !== null}
                onClick={() => props.onMove(profile.id, index + 1)}
              >
                {t("moveDown")}
              </button>
              <button
                type="button"
                className="button button-ghost"
                disabled={props.busyId !== null}
                onClick={() => props.onEdit(profile)}
              >
                {t("edit")}
              </button>
              <button
                type="button"
                className="button button-danger"
                disabled={props.busyId !== null}
                onClick={() => props.onForget(profile)}
              >
                {t("forget")}
              </button>
            </div>
          </article>
        </li>
      ))}
    </ul>
  );
}

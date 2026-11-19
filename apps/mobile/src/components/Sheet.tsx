import { useEffect, useId, useRef, type PointerEvent, type ReactNode } from "react";

interface SheetProps {
  readonly title: string;
  readonly description?: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Sheet(props: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  const drag = useRef<{ pointerId: number; y: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    drag.current = { pointerId: event.pointerId, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    drag.current = null;
    const dialog = dialogRef.current;
    if (!start || start.pointerId !== event.pointerId || !dialog) return;
    dialog.style.transform = "";
    if (event.clientY - start.y > 72) props.onClose();
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    const dialog = dialogRef.current;
    if (!start || start.pointerId !== event.pointerId || !dialog) return;
    const delta = Math.max(0, event.clientY - start.y);
    dialog.style.transform = `translateY(${delta}px)`;
  };

  return (
    <dialog
      ref={dialogRef}
      className={`sheet ${props.className ?? ""}`}
      aria-labelledby={titleId}
      aria-describedby={props.description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <div className="sheet-panel">
        <header
          className="sheet-header"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="sheet-heading">
            <h2 id={titleId}>{props.title}</h2>
            {props.description ? <p id={descriptionId}>{props.description}</p> : null}
          </div>
          <button type="button" className="button button-ghost" onClick={props.onClose}>
            {props.closeLabel}
          </button>
        </header>
        <div className="sheet-body">{props.children}</div>
      </div>
    </dialog>
  );
}

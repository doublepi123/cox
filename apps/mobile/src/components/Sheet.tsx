import { useEffect, useId, useRef, type ReactNode } from "react";

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
        <header className="sheet-header">
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

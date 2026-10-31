import { MousePointer2 } from "lucide-react";
import { useEffect, useState } from "react";
import { agentBrowserCursorOpacity, type BrowserController } from "./agentBrowserCursorLogic";
const CURSOR_ACTIVE_MS = 700;

export function AgentCursorMark(props: {
  readonly phase: "move" | "click";
  readonly sequence: number;
  readonly left: number;
  readonly top: number;
  readonly controller: BrowserController;
}) {
  const { phase, sequence, left, top, controller } = props;
  const [inactiveSequence, setInactiveSequence] = useState<number | null>(null);
  const active = inactiveSequence !== sequence;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer fades the agent cursor after each move or click
  useEffect(() => {
    const timeout = window.setTimeout(() => setInactiveSequence(sequence), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, [sequence]);

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-40 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none"
      style={{
        opacity: agentBrowserCursorOpacity(active, controller),
        transform: `translate3d(${left}px, ${top}px, 0)`,
      }}
      aria-hidden="true"
      data-agent-browser-cursor
    >
      {phase === "click" ? (
        <span
          key={sequence}
          className="absolute left-0.5 top-0.5 size-4 animate-status-ping rounded-full bg-primary/25 motion-reduce:animate-none"
        />
      ) : null}
      <MousePointer2 className="relative size-5 -translate-x-0.5 -translate-y-0.5 fill-background stroke-2 text-primary drop-shadow-sm" />
    </div>
  );
}

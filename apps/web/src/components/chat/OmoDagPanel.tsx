import { Link } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveOmoDagRuns,
  type OmoDagGraphNode,
  type OmoDagNodeState,
  type OmoDagRun,
  type OmoDagRunStatus,
} from "@t3tools/client-runtime/state/omoDag";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  ProviderDriverKind,
  type EnvironmentId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CircleStopIcon,
  CircleXIcon,
  ClockIcon,
  ListIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MinusIcon,
  PauseIcon,
  PlusIcon,
  RotateCcwIcon,
  ScanIcon,
  SkipForwardIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { isContextMenuOpen } from "../../contextMenuFallback";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useQuietThreadProjection } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Dialog, DialogBackdrop, DialogClose } from "../ui/dialog";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  layoutOmoDag,
  OMO_DAG_NODE_HEIGHT,
  OMO_DAG_NODE_WIDTH,
  omoDagLayoutSignature,
  type OmoDagLayoutNode,
} from "./OmoDagPanel.layout";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const MIN_SCALE = 0.35;
const MAX_SCALE = 2;
const PANEL_FIT_SCALE = 1;
const EXPANDED_FIT_SCALE = 1.6;
const TOOLBAR_BUTTON_CLASS =
  "inline-flex size-11 cursor-pointer sm:size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

type GraphPresentation = "graph" | "list";
type GraphSelection = { readonly runId: string; readonly nodeId: string } | null;
type GraphViewPresentation =
  | {
      readonly kind: "panel";
      readonly onExpand: () => void;
      readonly expandButtonId: string;
    }
  | { readonly kind: "expanded" };

const NODE_STATUS = {
  pending: { label: "Pending", icon: ClockIcon, tone: "text-muted-foreground" },
  blocked: { label: "Blocked", icon: CircleDashedIcon, tone: "text-warning" },
  scheduled: { label: "Scheduled", icon: ClockIcon, tone: "text-info" },
  running: { label: "Running", icon: LoaderCircleIcon, tone: "text-info" },
  paused: { label: "Paused", icon: PauseIcon, tone: "text-warning" },
  completed: { label: "Completed", icon: CheckCircleIcon, tone: "text-success" },
  failed: { label: "Failed", icon: CircleXIcon, tone: "text-destructive" },
  cancelled: { label: "Cancelled", icon: CircleStopIcon, tone: "text-muted-foreground" },
  skipped: { label: "Skipped", icon: SkipForwardIcon, tone: "text-muted-foreground" },
} as const satisfies Record<
  OmoDagNodeState,
  { label: string; icon: typeof ClockIcon; tone: string }
>;

const RUN_STATUS = {
  pending: "Pending",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
} as const satisfies Record<OmoDagRunStatus, string>;

const NODE_CARD_STATUS = {
  pending: "border-border/80 bg-card",
  blocked: "border-warning/45 bg-warning/5",
  scheduled: "border-info/35 bg-info/5",
  running: "border-info/60 bg-info/5",
  paused: "border-warning/60 bg-warning/5",
  completed: "border-success/45 bg-success/5",
  failed: "border-destructive/55 bg-destructive/5",
  cancelled: "border-border/80 bg-muted/25",
  skipped: "border-border/70 bg-muted/20",
} as const satisfies Record<OmoDagNodeState, string>;

const RUN_STATUS_TONE = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-info/10 text-info",
  paused: "bg-warning/10 text-warning",
  completed: "bg-success/10 text-success",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
} as const satisfies Record<OmoDagRunStatus, string>;

function selectedGraphNode(run: OmoDagRun, selection: GraphSelection): OmoDagGraphNode | undefined {
  const selected =
    selection === null || selection.runId !== run.id
      ? undefined
      : run.nodes.find((node) => node.id === selection.nodeId);
  return selected ?? run.nodes.find((node) => node.state === "running") ?? run.nodes[0];
}

function RunStatusPill({ status }: { readonly status: OmoDagRunStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-3xs font-medium",
        RUN_STATUS_TONE[status],
      )}
    >
      {t(RUN_STATUS[status])}
    </span>
  );
}

function CompletedCount({ run }: { readonly run: OmoDagRun }) {
  const { t } = useTranslation();
  const completed = run.nodes.filter((node) => node.state === "completed").length;
  return (
    <span
      className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-2xs tabular-nums text-muted-foreground"
      aria-label={t("{completed} of {total} graph nodes completed", {
        completed,
        total: run.nodes.length,
      })}
    >
      {completed}/{run.nodes.length}
    </span>
  );
}

function GraphPresentationToggle({
  view,
  onChange,
  className,
}: {
  readonly view: GraphPresentation;
  readonly onChange: (view: GraphPresentation) => void;
  readonly className?: string;
}) {
  const { t } = useTranslation();
  const buttonClass =
    "inline-flex h-6 cursor-pointer items-center gap-1 rounded px-1.5 text-2xs outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div
      className={cn("flex shrink-0 rounded-md bg-muted/65 p-0.5", className)}
      role="group"
      aria-label={t("Graph presentation")}
    >
      <button
        type="button"
        className={cn(
          buttonClass,
          view === "graph" ? "bg-card text-foreground shadow-xs" : "text-muted-foreground",
        )}
        aria-pressed={view === "graph"}
        onClick={() => onChange("graph")}
      >
        <WorkflowIcon aria-hidden className="size-3" />
        {t("Graph view")}
      </button>
      <button
        type="button"
        className={cn(
          buttonClass,
          view === "list" ? "bg-card text-foreground shadow-xs" : "text-muted-foreground",
        )}
        aria-pressed={view === "list"}
        onClick={() => onChange("list")}
      >
        <ListIcon aria-hidden className="size-3" />
        {t("List view")}
      </button>
    </div>
  );
}

function nodeDependencyLabels(run: OmoDagRun, nodeId: string): ReadonlyArray<string> {
  const labels = new Map(run.nodes.map((node) => [node.id, node.label]));
  return run.edges
    .filter((edge) => edge.to === nodeId)
    .map((edge) => labels.get(edge.from) ?? edge.from);
}

function GraphNodeCard({
  layoutNode,
  run,
  environmentId,
  selected,
  onSelect,
}: {
  readonly layoutNode: OmoDagLayoutNode;
  readonly run: OmoDagRun;
  readonly environmentId: EnvironmentId;
  readonly selected: boolean;
  readonly onSelect: (nodeId: string) => void;
}) {
  const { t } = useTranslation();
  const { node } = layoutNode;
  const status = NODE_STATUS[node.state];
  const StatusIcon = status.icon;
  const label = node.label.trim().length === 0 ? t("Untitled graph node") : node.label;
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={cn("flex min-w-0 items-center gap-1 text-2xs font-medium", status.tone)}>
          <StatusIcon
            aria-hidden
            className={cn("size-3 shrink-0", node.state === "running" && "animate-spin")}
          />
          {t(status.label)}
        </span>
        <span className="ml-auto shrink-0 text-3xs tabular-nums text-muted-foreground">
          {t("Attempt {count}", { count: node.attempt })}
        </span>
      </span>
      <span
        className="mt-1.5 line-clamp-2 min-w-0 text-left text-xs font-medium break-words text-foreground"
        title={label}
      >
        {label}
      </span>
      <span className="mt-auto flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate text-left" title={node.model}>
          {node.model ?? t("Model not reported")}
        </span>
        {node.childThreadId ? <ArrowUpRightIcon aria-hidden className="size-3 shrink-0" /> : null}
      </span>
    </>
  );
  const className = cn(
    "absolute flex cursor-pointer flex-col rounded-lg border px-2.5 py-2 shadow-xs outline-none transition-[border-color,box-shadow] hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    NODE_CARD_STATUS[node.state],
    selected && "border-ring ring-2 ring-ring/45",
  );
  const style = {
    left: layoutNode.x,
    top: layoutNode.y,
    width: OMO_DAG_NODE_WIDTH,
    height: OMO_DAG_NODE_HEIGHT,
  };
  const shared = {
    className,
    style,
    draggable: false,
    "data-omo-dag-node": node.id,
    "data-state": node.state,
    "data-selected": selected ? "true" : "false",
    "data-critical-path": run.criticalPath?.includes(node.id) ? "true" : undefined,
    onClick: () => onSelect(node.id),
  } as const;
  return node.childThreadId ? (
    <Link
      {...shared}
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(environmentId, node.childThreadId))}
      aria-label={t("Open graph node {label}", { label })}
      aria-current={selected ? "true" : undefined}
    >
      {content}
    </Link>
  ) : (
    <button
      {...shared}
      type="button"
      aria-label={t("Select graph node {label}", { label })}
      aria-pressed={selected}
    >
      {content}
    </button>
  );
}

function GraphView({
  run,
  environmentId,
  selectedNodeId,
  onSelect,
  presentation,
}: {
  readonly run: OmoDagRun;
  readonly environmentId: EnvironmentId;
  readonly selectedNodeId: string | undefined;
  readonly onSelect: (nodeId: string) => void;
  readonly presentation: GraphViewPresentation;
}) {
  const { t } = useTranslation();
  const expanded = presentation.kind === "expanded";
  const maxFitScale = expanded ? EXPANDED_FIT_SCALE : PANEL_FIT_SCALE;
  const viewportRef = useRef<HTMLDivElement>(null);
  const layout = layoutOmoDag(run);
  const layoutRef = useRef(layout);
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [transform, setTransform] = useState({ x: 8, y: 8, scale: 1 });
  const instructionsId = useId();
  const markerId = useId().replaceAll(":", "");

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const fitView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const current = layoutRef.current;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (width <= 0 || height <= 0) return;
    const scale = Math.min(
      maxFitScale,
      Math.max(MIN_SCALE, Math.min((width - 16) / current.width, (height - 16) / current.height)),
    );
    const scaledWidth = current.width * scale;
    const scaledHeight = current.height * scale;
    setTransform({
      scale,
      x: scaledWidth < width ? (width - scaledWidth) / 2 : 8,
      y: scaledHeight < height ? (height - scaledHeight) / 2 : 8,
    });
  }, [maxFitScale]);

  const resetView = useCallback(() => {
    const viewport = viewportRef.current;
    const current = layoutRef.current;
    const width = viewport?.clientWidth ?? current.width;
    setTransform({
      scale: 1,
      x: current.width < width ? (width - current.width) / 2 : 8,
      y: 8,
    });
  }, []);

  const zoom = useCallback((factor: number, focus?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const point = focus ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const localX = point.x - rect.left;
    const localY = point.y - rect.top;
    setTransform((current) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
      const ratio = scale / current.scale;
      return {
        scale,
        x: localX - (localX - current.x) * ratio,
        y: localY - (localY - current.y) * ratio,
      };
    });
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    fitView();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fitView);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitView]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoom(event.deltaY > 0 ? 0.9 : 1.1, { x: event.clientX, y: event.clientY });
        return;
      }
      const unit = event.deltaMode === 1 ? 16 : 1;
      setTransform((current) => ({
        ...current,
        x: current.x - event.deltaX * unit,
        y: current.y - event.deltaY * unit,
      }));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [zoom]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest("a, button"))
    ) {
      return;
    }
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan?.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - pan.x;
    const deltaY = event.clientY - pan.y;
    panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setTransform((current) => ({ ...current, x: current.x + deltaX, y: current.y + deltaY }));
  };

  const stopPointerPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      className={cn(
        "min-w-0",
        expanded ? "flex min-h-0 flex-1 flex-col px-3 pb-3 sm:px-4 sm:pb-4" : "px-2.5 pb-2",
      )}
    >
      <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1">
        <button
          type="button"
          className={TOOLBAR_BUTTON_CLASS}
          aria-label={t("Fit graph")}
          title={t("Fit graph")}
          onClick={fitView}
        >
          <ScanIcon aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          className={TOOLBAR_BUTTON_CLASS}
          aria-label={t("Zoom graph out")}
          title={t("Zoom graph out")}
          onClick={() => zoom(1 / 1.2)}
        >
          <MinusIcon aria-hidden className="size-3.5" />
        </button>
        <span
          className="min-w-10 text-center text-2xs tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {Math.round(transform.scale * 100)}%
        </span>
        <button
          type="button"
          className={TOOLBAR_BUTTON_CLASS}
          aria-label={t("Zoom graph in")}
          title={t("Zoom graph in")}
          onClick={() => zoom(1.2)}
        >
          <PlusIcon aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          className={TOOLBAR_BUTTON_CLASS}
          aria-label={t("Reset graph view")}
          title={t("Reset graph view")}
          onClick={resetView}
        >
          <RotateCcwIcon aria-hidden className="size-3.5" />
        </button>
        {presentation.kind === "panel" ? (
          <button
            id={presentation.expandButtonId}
            type="button"
            className={cn(TOOLBAR_BUTTON_CLASS, "ml-auto")}
            aria-label={t("Expand graph")}
            title={t("Expand graph")}
            onClick={presentation.onExpand}
          >
            <Maximize2Icon aria-hidden className="size-3.5" />
          </button>
        ) : null}
      </div>
      <p id={instructionsId} className="sr-only">
        {t("Use arrow keys to pan. Use plus or minus to zoom. Press F to fit and 0 to reset.")}
      </p>
      <div
        ref={viewportRef}
        role="region"
        tabIndex={0}
        aria-label={t("Interactive dependency graph")}
        aria-describedby={instructionsId}
        data-omo-dag-viewport
        data-scale={transform.scale}
        data-pan-x={transform.x}
        data-pan-y={transform.y}
        className={cn(
          "relative min-w-0 cursor-grab touch-none overflow-hidden rounded-lg border border-border/70 bg-muted/15 outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
          expanded ? "min-h-0 flex-1" : "h-72 sm:h-80",
        )}
        onPointerDown={onPointerDown}
        onDoubleClick={
          presentation.kind === "panel"
            ? (event) => {
                if (event.target instanceof Element && event.target.closest("a, button")) return;
                presentation.onExpand();
              }
            : undefined
        }
        onPointerMove={onPointerMove}
        onPointerUp={stopPointerPan}
        onPointerCancel={stopPointerPan}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            setTransform((current) => ({
              ...current,
              x: current.x + (event.key === "ArrowLeft" ? 32 : -32),
            }));
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setTransform((current) => ({
              ...current,
              y: current.y + (event.key === "ArrowUp" ? 32 : -32),
            }));
          } else if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            zoom(1.2);
          } else if (event.key === "-") {
            event.preventDefault();
            zoom(1 / 1.2);
          } else if (event.key.toLowerCase() === "f") {
            event.preventDefault();
            fitView();
          } else if (event.key === "0") {
            event.preventDefault();
            resetView();
          }
        }}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
        >
          <svg
            aria-hidden
            className="absolute inset-0 overflow-visible"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
          >
            <defs>
              <marker
                id={`${markerId}-edge`}
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" className="fill-muted-foreground/55" />
              </marker>
              <marker
                id={`${markerId}-critical`}
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" className="fill-primary/75" />
              </marker>
            </defs>
            {layout.edges.map((edge) => (
              <path
                key={`${edge.from}:${edge.to}`}
                d={edge.path}
                fill="none"
                className={edge.critical ? "stroke-primary/70" : "stroke-muted-foreground/40"}
                strokeWidth={edge.critical ? 2 : 1.5}
                vectorEffect="non-scaling-stroke"
                markerEnd={`url(#${markerId}-${edge.critical ? "critical" : "edge"})`}
                data-omo-dag-edge={`${edge.from}:${edge.to}`}
              />
            ))}
          </svg>
          {layout.waves.map((wave) => (
            <span
              key={wave.index}
              className="absolute left-5 text-2xs font-medium tracking-wide text-muted-foreground uppercase select-none"
              style={{ top: wave.y }}
            >
              {t("Wave {index}", { index: wave.index + 1 })}
            </span>
          ))}
          {layout.nodes.map((layoutNode) => (
            <GraphNodeCard
              key={layoutNode.node.id}
              layoutNode={layoutNode}
              run={run}
              environmentId={environmentId}
              selected={selectedNodeId === layoutNode.node.id}
              onSelect={onSelect}
            />
          ))}
        </div>
        {run.nodes.length === 0 ? (
          <p className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t("No graph nodes")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function GraphListRow({
  run,
  node,
  environmentId,
  selected,
  onSelect,
}: {
  readonly run: OmoDagRun;
  readonly node: OmoDagGraphNode;
  readonly environmentId: EnvironmentId;
  readonly selected: boolean;
  readonly onSelect: (nodeId: string) => void;
}) {
  const { t } = useTranslation();
  const status = NODE_STATUS[node.state];
  const StatusIcon = status.icon;
  const label = node.label.trim().length === 0 ? t("Untitled graph node") : node.label;
  const dependencies = nodeDependencyLabels(run, node.id);
  const content = (
    <>
      <span className="flex min-w-0 items-start gap-2">
        <StatusIcon
          aria-hidden
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            status.tone,
            node.state === "running" && "animate-spin",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block font-medium break-words text-foreground [overflow-wrap:anywhere]">
            {label}
          </span>
          <span className="mt-0.5 block text-2xs break-words text-muted-foreground [overflow-wrap:anywhere]">
            {t(status.label)}
            {" · "}
            {node.model ?? t("Model not reported")}
          </span>
        </span>
        {node.childThreadId ? (
          <ArrowUpRightIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        ) : null}
      </span>
      {dependencies.length > 0 ? (
        <span className="mt-1 block pl-5 text-2xs break-words text-muted-foreground [overflow-wrap:anywhere]">
          {t("Depends on {dependencies}", { dependencies: dependencies.join(", ") })}
        </span>
      ) : null}
    </>
  );
  const className = cn(
    "block w-full cursor-pointer rounded-md px-2 py-2 text-left text-xs outline-none hover:bg-muted/65 focus-visible:ring-2 focus-visible:ring-ring",
    selected && "bg-muted/70 ring-1 ring-ring/45",
  );
  return node.childThreadId ? (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(environmentId, node.childThreadId))}
      className={className}
      aria-label={t("Open graph node {label}", { label })}
      aria-current={selected ? "true" : undefined}
      data-omo-dag-list-node={node.id}
      onClick={() => onSelect(node.id)}
    >
      {content}
    </Link>
  ) : (
    <button
      type="button"
      className={className}
      aria-label={t("Select graph node {label}", { label })}
      aria-pressed={selected}
      data-omo-dag-list-node={node.id}
      onClick={() => onSelect(node.id)}
    >
      {content}
    </button>
  );
}

function GraphListView({
  run,
  environmentId,
  selectedNodeId,
  onSelect,
  variant,
}: {
  readonly run: OmoDagRun;
  readonly environmentId: EnvironmentId;
  readonly selectedNodeId: string | undefined;
  readonly onSelect: (nodeId: string) => void;
  readonly variant: "panel" | "expanded";
}) {
  const { t } = useTranslation();
  const layout = layoutOmoDag(run);
  return (
    <div
      className={cn(
        "min-w-0 overflow-y-auto overscroll-contain",
        variant === "expanded" ? "min-h-0 flex-1 px-3 pb-3 sm:px-4" : "max-h-80 px-2.5 pb-2",
      )}
      data-omo-dag-list
    >
      {layout.waves.map((wave) => (
        <div key={wave.index} className="mb-2 last:mb-0">
          <h4 className="px-2 py-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("Wave {index}", { index: wave.index + 1 })}
          </h4>
          <ul className="min-w-0 space-y-0.5">
            {wave.nodes.map(({ node }) => (
              <li key={node.id} className="min-w-0">
                <GraphListRow
                  run={run}
                  node={node}
                  environmentId={environmentId}
                  selected={selectedNodeId === node.id}
                  onSelect={onSelect}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {run.nodes.length === 0 ? (
        <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t("No graph nodes")}</p>
      ) : null}
    </div>
  );
}

function GraphNodeDetails({
  run,
  node,
  variant,
}: {
  readonly run: OmoDagRun;
  readonly node: OmoDagGraphNode;
  readonly variant: "panel" | "expanded";
}) {
  const { t } = useTranslation();
  const dependencies = nodeDependencyLabels(run, node.id);
  const fields = [
    { label: t("Status"), value: t(NODE_STATUS[node.state].label) },
    { label: t("Model"), value: node.model ?? t("Model not reported") },
    { label: t("Attempt"), value: String(node.attempt) },
    {
      label: t("Dependencies"),
      value: dependencies.length > 0 ? dependencies.join(", ") : t("No dependencies"),
    },
    { label: t("Progress"), value: node.progress ?? t("Not reported") },
    { label: t("Task"), value: node.prompt || t("Not reported") },
    ...(run.criticalPath?.includes(node.id)
      ? [{ label: t("Critical path"), value: t("On critical path") }]
      : []),
    ...(node.lastError
      ? [{ label: `${t("Error")} (${node.lastError.code})`, value: node.lastError.message }]
      : []),
  ];
  return (
    <div
      className={cn(
        "min-w-0 overflow-y-auto overscroll-contain",
        variant === "expanded"
          ? "max-h-[45%] min-h-0 flex-none border-t border-border/70 px-4 py-3 lg:max-h-none lg:w-[22rem] lg:border-t-0 lg:border-l"
          : "mx-2.5 mb-1 max-h-64 rounded-lg border border-border/65 bg-muted/15 px-2.5 py-2",
      )}
      aria-label={t("Graph node details")}
      data-omo-dag-details
    >
      <div className="mb-2 flex min-w-0 items-start gap-2">
        <h4 className="min-w-0 flex-1 text-xs font-medium break-words text-foreground [overflow-wrap:anywhere]">
          {node.label.trim().length === 0 ? t("Untitled graph node") : node.label}
        </h4>
        {run.criticalPath?.includes(node.id) ? (
          <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-3xs text-primary">
            {t("Critical path")}
          </span>
        ) : null}
      </div>
      <dl className="min-w-0 space-y-1.5 text-2xs">
        {fields.map((field) => (
          <div
            key={field.label}
            className="grid min-w-0 grid-cols-[minmax(72px,0.35fr)_minmax(0,1fr)] gap-2"
          >
            <dt className="text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground [overflow-wrap:anywhere]">
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ExpandedGraphContent({
  run,
  environmentId,
  selectedNode,
  onSelect,
  onClose,
}: {
  readonly run: OmoDagRun;
  readonly environmentId: EnvironmentId;
  readonly selectedNode: OmoDagGraphNode | undefined;
  readonly onSelect: (nodeId: string) => void;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<GraphPresentation>("graph");
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/70 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <DialogPrimitive.Title
            className="min-w-0 truncate text-sm font-semibold text-foreground"
            title={run.name}
          >
            {run.name}
          </DialogPrimitive.Title>
          <RunStatusPill status={run.status} />
          <CompletedCount run={run} />
        </div>
        <GraphPresentationToggle
          view={view}
          onChange={setView}
          className="order-last max-sm:w-full max-sm:justify-center sm:order-none"
        />
        <DialogClose aria-label={t("Close")} render={<Button size="icon" variant="ghost" />}>
          <XIcon />
        </DialogClose>
      </div>
      {run.truncated ? (
        <p className="border-b border-border/70 px-4 py-1.5 text-2xs text-warning">
          {t("This graph is truncated. Some nodes may be omitted.")}
        </p>
      ) : null}
      <div
        className="flex min-h-0 flex-1 flex-col lg:flex-row"
        onClick={(event) => {
          if (
            event.button === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey &&
            event.target instanceof Element &&
            event.target.closest("a[href]")
          ) {
            onClose();
          }
        }}
      >
        <div className="flex min-h-[55%] min-w-0 flex-1 flex-col pt-3 lg:min-h-0">
          {view === "graph" ? (
            <GraphView
              key={`${run.id}:${omoDagLayoutSignature(run)}`}
              run={run}
              environmentId={environmentId}
              selectedNodeId={selectedNode?.id}
              onSelect={onSelect}
              presentation={{ kind: "expanded" }}
            />
          ) : (
            <GraphListView
              run={run}
              environmentId={environmentId}
              selectedNodeId={selectedNode?.id}
              onSelect={onSelect}
              variant="expanded"
            />
          )}
        </div>
        {selectedNode ? (
          <GraphNodeDetails run={run} node={selectedNode} variant="expanded" />
        ) : null}
      </div>
    </>
  );
}

function OmoDagRunsPanel({
  runs,
  environmentId,
  threadId,
  providers,
}: {
  readonly runs: ReadonlyArray<OmoDagRun>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const { t } = useTranslation();
  const [selectedRunId, setSelectedRunId] = useState(runs[0]!.id);
  const [selection, setSelection] = useState<GraphSelection>(null);
  const [view, setView] = useState<GraphPresentation>("graph");
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const expandButtonId = useId();
  const run = runs.find((candidate) => candidate.id === selectedRunId) ?? runs[0]!;
  const expandedRun =
    expandedRunId === null ? undefined : runs.find((candidate) => candidate.id === expandedRunId);
  if (expandedRunId !== null && expandedRun === undefined) {
    setExpandedRunId(null);
  }
  const selectedNode = selectedGraphNode(run, selection);
  const provider = providers.find((candidate) => candidate.instanceId === run.providerInstanceId);
  const providerEntry = deriveProviderInstanceEntries(providers).find(
    (candidate) => candidate.instanceId === run.providerInstanceId,
  );
  const onSelect = (nodeId: string) => setSelection({ runId: run.id, nodeId });
  const closeExpanded = () => setExpandedRunId(null);
  return (
    <ThreadDetailsSection
      headingId={`thread-details-omo-dag-${threadId}`}
      title={t("Dependency graph")}
      data-omo-dag-panel
      actions={<CompletedCount run={run} />}
    >
      <div className="min-w-0 px-2.5 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderInstanceIcon
            driverKind={provider?.driver ?? ProviderDriverKind.make("omo")}
            displayName={providerEntry?.displayName ?? "OMO"}
            accentColor={providerEntry?.accentColor}
            acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
            showBadge={providerEntry?.accentColor !== undefined}
            badgeContent="none"
            className="size-5 shrink-0"
            iconClassName="size-5"
          />
          <select
            className="h-7 min-w-0 flex-1 cursor-pointer rounded-md border border-border/70 bg-card px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("Dependency run")}
            value={run.id}
            onChange={(event) => {
              setSelectedRunId(event.target.value);
              setSelection(null);
            }}
          >
            {runs.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          <RunStatusPill status={run.status} />
        </div>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-1.5">
          <span
            className="min-w-0 truncate text-2xs text-muted-foreground"
            title={providerEntry?.displayName ?? "OMO"}
          >
            {providerEntry?.displayName ?? "OMO"}
            {" · "}
            {t("Generation {generation}", { generation: run.generation })}
          </span>
          <GraphPresentationToggle view={view} onChange={setView} />
        </div>
        {run.truncated ? (
          <p className="mt-1.5 text-2xs text-warning">
            {t("This graph is truncated. Some nodes may be omitted.")}
          </p>
        ) : null}
      </div>
      {view === "graph" ? (
        <GraphView
          key={`${run.id}:${omoDagLayoutSignature(run)}`}
          run={run}
          environmentId={environmentId}
          selectedNodeId={selectedNode?.id}
          onSelect={onSelect}
          presentation={{
            kind: "panel",
            onExpand: () => setExpandedRunId(run.id),
            expandButtonId,
          }}
        />
      ) : (
        <GraphListView
          run={run}
          environmentId={environmentId}
          selectedNodeId={selectedNode?.id}
          onSelect={onSelect}
          variant="panel"
        />
      )}
      {selectedNode ? <GraphNodeDetails run={run} node={selectedNode} variant="panel" /> : null}
      <Dialog
        open={expandedRun !== undefined}
        onOpenChange={(open, eventDetails) => {
          if (open) return;
          if (eventDetails.reason === "escape-key" && isContextMenuOpen()) {
            eventDetails.cancel();
            return;
          }
          closeExpanded();
        }}
      >
        <DialogPrimitive.Portal>
          <DialogBackdrop />
          <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-center justify-center">
            <DialogPrimitive.Popup
              finalFocus={() => document.getElementById(expandButtonId)}
              data-slot="dialog-popup"
              data-omo-dag-expanded
              className="relative flex h-[90vh] w-[94vw] min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-2xl/40 outline-none transition-[opacity,scale] duration-150 ease-out [-webkit-app-region:no-drag] data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-starting-style:scale-[0.985] data-starting-style:opacity-0 max-sm:size-full max-sm:rounded-none max-sm:border-0 max-sm:pt-safe max-sm:pr-safe max-sm:pb-safe max-sm:pl-safe"
            >
              {expandedRun ? (
                <ExpandedGraphContent
                  run={expandedRun}
                  environmentId={environmentId}
                  selectedNode={selectedGraphNode(expandedRun, selection)}
                  onSelect={(nodeId) => setSelection({ runId: expandedRun.id, nodeId })}
                  onClose={closeExpanded}
                />
              ) : null}
            </DialogPrimitive.Popup>
          </DialogPrimitive.Viewport>
        </DialogPrimitive.Portal>
      </Dialog>
    </ThreadDetailsSection>
  );
}

export function OmoDagPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const thread = useQuietThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const providers = useEnvironmentProviders().get(props.environmentId) ?? EMPTY_PROVIDERS;
  const runs = deriveOmoDagRuns(thread?.projection.subagents ?? []);
  if (runs.length === 0) return null;
  return (
    <OmoDagRunsPanel
      runs={runs}
      environmentId={props.environmentId}
      threadId={props.threadId}
      providers={providers}
    />
  );
}

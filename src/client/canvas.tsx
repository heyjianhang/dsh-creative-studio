import { useState, useRef, useEffect, useContext, createContext } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  NodeResizeControl,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  useConnection,
  type Node,
  type Edge,
  type NodeProps,
  type XYPosition,
} from "@xyflow/react";
import {
  Button,
  Menu,
  Tooltip,
  MarkdownText,
  Modal,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { SessionReference } from "@deepseek-ai/dsh-api-session-controller/client";
import type { CanvasProps, Request } from "./props.ts";
import type { CreativeNode, Project, Resource } from "../shared/contracts.ts";
import {
  generationDefaults,
  rememberGeneration,
} from "../shared/generation-preferences.ts";
import type { Key } from "./locales.ts";
import { Icon, type IconName } from "./icons.tsx";
import { CanvasMedia } from "./canvas-media.tsx";
import { NodePanel } from "./node-panel.tsx";
import { downloadMedia } from "./media-source.ts";
import { MediaDownloadDialogs } from "./media-downloads.tsx";
import { NodePins, PinPicker } from "./node-pins.tsx";
import { SaveCreativeResources } from "./save-creative-resources.tsx";
import { reconcileNodes, reconcileEdges } from "./canvas-state.ts";
import { MediaView, upload } from "./media.tsx";
import { MediaPreview } from "./media-preview.tsx";
import { MarkdownEditor } from "./markdown-editor.tsx";
import { ProjectSwitcher } from "./project-switcher.tsx";
import { CanvasMinimap } from "./canvas-minimap.tsx";
import { AssetLibrary } from "./asset-library.tsx";
import { TextComposer, type ReferencePicking } from "./text-composer.tsx";
import { MediaComposer } from "./media-composer.tsx";
import { MediaSettings } from "./media-settings.tsx";
import { TemplateLibrary } from "./template-library.tsx";
import { templateNodeData } from "../shared/template-application.ts";
import { useMediaJobs } from "./media-jobs.ts";
import {
  GenerationCard,
  latestBatch,
  jobActive,
  type CardJob,
} from "./generation-card.tsx";
import { mediaComposerOf } from "../shared/media-contracts.ts";
import {
  changeFrame,
  continuationComposer,
  isGenerationNode,
  mediaReferenceIds,
} from "../shared/media-reference.ts";
import { useTextJobs } from "./text-jobs.ts";
import {
  composerOf,
  referenceIds,
  referencePickProblem,
  framePickProblem,
} from "../shared/text-generation.ts";
import css from "./studio.module.css";
type FlowNode = Node<CreativeNode["data"], "creative">;
const NodeContext = createContext<{
  request: Request;
  projectId: string;
  t: (k: Key) => string;
  pick(id: string): void;
  jobs(id: string): CardJob[];
  jobAction(job: CardJob, action: "cancel" | "retry" | "configure"): void;
  referenceState(id: string): { invalid?: string } | undefined;
  dimensions(id: string): { width?: number; height?: number };
  resize(
    id: string,
    rect: { x: number; y: number; width: number; height: number },
  ): void;
  muted: boolean;
  setMuted(muted: boolean): void;
  expand(id: string, start: number): void;
} | null>(null);
function ContentNode({ id, data, selected }: NodeProps<FlowNode>) {
  const connecting = useConnection((connection) => connection.inProgress);
  const c = useContext(NodeContext)!;
  const refState = c.referenceState(id);
  const jobs = c.jobs(id),
    inProgress = jobs.some(jobActive);
  const streamed = jobs.find(
    (j) => j.index === 0 && "text" in j && jobActive(j),
  );
  const streamedText = streamed && "text" in streamed ? streamed.text : "";
  const visibleJobs = jobs.filter(
    (j) =>
      jobActive(j) || ["failed", "uncertain", "cancelled"].includes(j.status),
  );
  // React Flow's NodeProps dimensions are measurements, not the user's saved size.
  const dimensions = data.kind === "text" ? c.dimensions(id) : undefined;
  return (
    <div
      className={css.contentNode}
      data-selected={selected}
      data-connecting={connecting}
      data-generating={inProgress}
      data-media-node={data.kind !== "text"}
      data-reference-mode={!!refState}
      data-reference-invalid={!!refState?.invalid}
      aria-busy={inProgress || undefined}
      aria-disabled={refState ? !!refState.invalid : undefined}
      title={refState?.invalid}
      style={dimensions}
    >
      <div className={css.nodeCaption}>
        <Icon name={data.kind} size={15} />
        <span>{data.label || c.t(data.kind)}</span>
        <NodePins colors={data.colorPins} />
      </div>
      <Handle
        type="target"
        position={Position.Left}
        aria-label={c.t("connectInput")}
      >
        <Icon name="plus" size={16} />
      </Handle>
      {data.kind === "text" && selected && !refState && (
        <NodeResizeControl
          position="top-right"
          className={css.textResizeHandle}
          minWidth={180}
          minHeight={120}
          maxWidth={1200}
          maxHeight={1600}
          onResizeEnd={(_, rect) => c.resize(id, rect)}
        >
          <span title={c.t("resizeText")} aria-label={c.t("resizeText")}>
            <svg
              width="26"
              height="26"
              viewBox="0 0 26 26"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M5 5C15 5 21 11 21 21"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          </span>
        </NodeResizeControl>
      )}
      {data.kind === "text" ? (
        <div
          className={css.textNode}
          data-sized={!!dimensions?.height}
          title={c.t("editBody")}
        >
          {streamedText || data.text ? (
            <div className={css.textNodeMarkdown}>
              <MarkdownText
                text={streamedText || data.text}
                variant="compact"
                labels={{
                  code: {
                    copyLabel: c.t("copyText"),
                    copiedLabel: c.t("copied"),
                  },
                  footnotes: c.t("footnotes"),
                }}
              />
            </div>
          ) : (
            <span className={css.textNodePlaceholder}>
              {c.t("textPlaceholder")}
            </span>
          )}
        </div>
      ) : data.media || data.asset ? (
        <CanvasMedia
          request={c.request}
          projectId={c.projectId}
          data={data}
          canvas={{
            t: c.t,
            muted: c.muted,
            onMutedChange: c.setMuted,
            onExpand: (start) => c.expand(id, start),
          }}
        />
      ) : (
        <button className={css.nodeEmpty} type="button" tabIndex={-1}>
          {!inProgress && <Icon name={data.kind} size={36} />}
          {!inProgress && (
            <span>
              {c.t(
                data.kind === "image"
                  ? "imageGenerationHint"
                  : "videoGenerationHint",
              )}
            </span>
          )}
        </button>
      )}
      {data.kind === "text" && !!visibleJobs.length && (
        <GenerationCard jobs={visibleJobs} t={c.t} action={c.jobAction} />
      )}
      {data.kind !== "text" && inProgress && (
        <div className={css.mediaGenerationEffect} aria-hidden="true">
          <div className={css.mediaGenerationSweep} />
        </div>
      )}
      <Handle
        type="source"
        position={Position.Right}
        aria-label={c.t("connectOutput")}
      >
        <Icon name="plus" size={16} />
      </Handle>
    </div>
  );
}
const nodeTypes = { creative: ContentNode };
function Tool({
  label,
  icon,
  onClick,
  active,
  disabled,
  side = "right",
}: {
  label: string;
  icon: IconName;
  onClick(): void;
  active?: boolean;
  disabled?: boolean;
  side?: "right" | "top";
}) {
  return (
    <Tooltip label={label} side={side} portal>
      <Button
        className={css.tool}
        data-active={active}
        aria-pressed={active}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon name={icon} />
      </Button>
    </Tooltip>
  );
}
function clean(nodes: FlowNode[]): CreativeNode[] {
  return nodes.map(({ id, position, data, width, height }) => ({
    id,
    type: "creative",
    position,
    data,
    ...(data.kind === "text" ? { width, height } : {}),
  }));
}
function cleanEdges(edges: Edge[]) {
  return edges.map(({ id, source, target }) => ({ id, source, target }));
}
export function Canvas(p: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasBody {...p} />
      <MediaDownloadDialogs p={p} />
    </ReactFlowProvider>
  );
}
function CanvasBody(p: CanvasProps) {
  const state = p.useStudio((s) => s),
    project = state.current!;
  const [nodes, setNodes] = useState<FlowNode[]>(() =>
      project.nodes.map((n) => ({ ...n, draggable: true })),
    ),
    [edges, setEdges] = useState<Edge[]>(() => project.edges);
  const nodesRef = useRef(nodes),
    edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const uploadAbort = useRef<AbortController | null>(null);
  const root = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    uploadDestination = useRef<{ target?: string; point: XYPosition }>(),
    assetPoint = useRef<XYPosition>();
  const [menu, setMenu] = useState<{
      x: number;
      y: number;
      point: XYPosition;
    } | null>(null),
    [panel, setPanel] = useState<"assets" | "assistant" | null>(null),
    [assetDraft, setAssetDraft] = useState<Resource[]>(),
    [minimap, setMinimap] = useState(false),
    [help, setHelp] = useState(false),
    [templatesOpen, setTemplatesOpen] = useState(false),
    [preview, setPreview] = useState<FlowNode | null>(null);
  const [previewStart, setPreviewStart] = useState<number>();
  const [picking, setPicking] = useState<ReferencePicking | null>(null);
  const [editingText, setEditingText] = useState<string>();
  const [mediaConfig, setMediaConfig] = useState<string>(),
    [mediaConfigRevision, setMediaConfigRevision] = useState(0);
  const textJobs = useTextJobs(p, project.id);
  const mediaJobs = useMediaJobs(p, project.id);
  const [progress, setProgress] = useState(""),
    [error, setError] = useState(""),
    [agent, setAgent] = useState<SessionReference | null>(null),
    [agentError, setAgentError] = useState("");
  const [zoom, setZoom] = useState(project.viewport.zoom),
    flow = useReactFlow<FlowNode>();
  const selected = nodes.find((n) => n.selected),
    selectedCount = nodes.filter((n) => n.selected).length;
  const muted = project.playbackPreferences?.muted ?? true;
  const setMuted = (muted: boolean) => {
    if ((p.editor.current?.playbackPreferences?.muted ?? true) !== muted)
      commit(undefined, undefined, false, { playbackPreferences: { muted } });
  };
  const expand = (node: FlowNode, start?: number) => {
    root.current
      ?.querySelector<HTMLElement>(`.react-flow__node[data-id="${node.id}"]`)
      ?.querySelector("video")
      ?.pause();
    setPreviewStart(start);
    setPreview(node);
  };
  const clipboard = useRef<{ nodes: FlowNode[]; edges: Edge[] } | null>(null);
  useEffect(() => {
    setNodes((old) => reconcileNodes(old, project.nodes));
    setEdges((old) => reconcileEdges(old, project.edges));
  }, [project.nodes, project.edges]);
  useEffect(() => {
    if (state.focusNodeId)
      setNodes((old) =>
        old.map((node) => ({
          ...node,
          selected: node.id === state.focusNodeId,
        })),
      );
  }, [state.focusNodeId]);
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
    const fileInput = input.current;
    const cancelUploadSelection = () => {
      uploadDestination.current = undefined;
    };
    fileInput?.addEventListener("cancel", cancelUploadSelection);
    return () => {
      fileInput?.removeEventListener("cancel", cancelUploadSelection);
      uploadAbort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (panel !== "assistant") return;
    let active = true,
      reference: SessionReference | undefined;
    setAgentError("");
    void p.editor
      .flush()
      .then(() => p.retainAgent(project.id))
      .then((r) => {
        reference = r;
        if (active) setAgent(r);
        else r.release();
      })
      .catch((e) => {
        if (active) setAgentError(e.message);
      });
    return () => {
      active = false;
      reference?.release();
      setAgent(null);
    };
  }, [panel, project.id]);
  useEffect(() => {
    if (
      panel ||
      !selected ||
      selectedCount !== 1 ||
      selected.id !== picking?.target
    )
      setPicking(null);
    if (selected?.id !== editingText) setEditingText(undefined);
  }, [panel, selected?.id, selectedCount]);
  function commit(
    nextNodes = nodesRef.current,
    nextEdges = edgesRef.current,
    history = true,
    patch: Partial<Project> = {},
  ) {
    const current = p.editor.current!;
    p.editor.change(
      {
        ...current,
        ...patch,
        nodes: clean(nextNodes),
        edges: cleanEdges(nextEdges),
      },
      history,
    );
  }
  function center() {
    const rect = root.current!.getBoundingClientRect();
    return flow.screenToFlowPosition({
      x: rect.left + rect.width * 0.46,
      y: rect.top + rect.height * 0.42,
    });
  }
  function add(
    kind: CreativeNode["data"]["kind"],
    point = menu?.point ?? center(),
    extra: Partial<CreativeNode["data"]> = {},
    commitChange = true,
  ) {
    const origin = { ...point };
    point = { ...origin };
    let offset = 0;
    while (
      nodesRef.current.some(
        (n) =>
          Math.abs(n.position.x - point.x) < 290 &&
          Math.abs(n.position.y - point.y) < 210,
      ) &&
      offset < 1500
    ) {
      offset++;
      point = {
        x: origin.x + (offset % 3) * 320,
        y: origin.y + Math.floor(offset / 3) * 240,
      };
    }
    const n: FlowNode = {
      id: crypto.randomUUID(),
      type: "creative",
      position: point,
      data: {
        kind,
        label: p.t(kind),
        text: "",
        ...generationDefaults(p.editor.current!, kind),
        ...extra,
      },
      selected: true,
    };
    const next = [
      ...nodesRef.current.map((x) => ({ ...x, selected: false })),
      n,
    ];
    nodesRef.current = next;
    setNodes(next);
    if (commitChange) commit(next);
    setMenu(null);
    setError("");
    if (commitChange)
      requestAnimationFrame(() => root.current?.focus({ preventScroll: true }));
    return n;
  }
  function duplicate() {
    const source = nodesRef.current.filter((n) => n.selected);
    if (!source.length) return;
    clipboard.current = {
      nodes: source,
      edges: edgesRef.current.filter(
        (e) =>
          source.some((n) => n.id === e.source) &&
          source.some((n) => n.id === e.target),
      ),
    };
    paste();
  }
  function paste() {
    const clip = clipboard.current;
    if (!clip) return;
    const ids = new Map(clip.nodes.map((n) => [n.id, crypto.randomUUID()]));
    const copies = clip.nodes.map((n) => ({
      ...structuredClone(n),
      id: ids.get(n.id)!,
      data: {
        ...structuredClone(n.data),
        appliedGenerationIds: undefined,
        mediaComposer: n.data.mediaComposer
          ? {
              ...structuredClone(n.data.mediaComposer),
              referenceIds: n.data.mediaComposer.referenceIds.map(
                (id) => ids.get(id) ?? id,
              ),
              prompt: n.data.mediaComposer.prompt.map((part) =>
                part.type === "reference"
                  ? { ...part, nodeId: ids.get(part.nodeId) ?? part.nodeId }
                  : part,
              ),
            }
          : undefined,
        composer: n.data.composer
          ? {
              ...structuredClone(n.data.composer),
              referenceIds: n.data.composer.referenceIds.map(
                (id) => ids.get(id) ?? id,
              ),
              prompt: n.data.composer.prompt.map((part) =>
                part.type === "reference"
                  ? { ...part, nodeId: ids.get(part.nodeId) ?? part.nodeId }
                  : part,
              ),
            }
          : undefined,
      },
      position: { x: n.position.x + 40, y: n.position.y + 40 },
      selected: true,
    }));
    const next = [
        ...nodesRef.current.map((n) => ({ ...n, selected: false })),
        ...copies,
      ],
      nextEdges = [
        ...edgesRef.current,
        ...clip.edges
          .filter(
            (e) =>
              ids.has(e.source) &&
              ids.has(e.target) &&
              !e.id.startsWith("reference:"),
          )
          .map((e) => ({
            id: crypto.randomUUID(),
            source: ids.get(e.source)!,
            target: ids.get(e.target)!,
          })),
      ];
    for (const node of copies) {
      for (const source of referenceIds(composerOf(node))) {
        if (
          next.some((n) => n.id === source) &&
          !nextEdges.some((e) => e.source === source && e.target === node.id)
        )
          nextEdges.push({
            id: `reference:${node.id}:${source}`,
            source,
            target: node.id,
          });
      }
    }
    setNodes(next);
    setEdges(nextEdges);
    commit(next, nextEdges);
  }
  function remove() {
    const ids = new Set(
      nodesRef.current.filter((n) => n.selected).map((n) => n.id),
    );
    const removedReferences = edgesRef.current.filter(
      (e) => e.selected && e.id.startsWith("reference:"),
    );
    const next = nodesRef.current
        .filter((n) => !ids.has(n.id))
        .map((n) => {
          const sources = new Set(
            removedReferences
              .filter((e) => e.target === n.id)
              .map((e) => e.source),
          );
          if (!sources.size) return n;
          const config = composerOf(n);
          const nextConfig = {
            ...config,
            referenceIds: config.referenceIds.filter((id) => !sources.has(id)),
            prompt: config.prompt.filter(
              (part) => part.type !== "reference" || !sources.has(part.nodeId),
            ),
          };
          return {
            ...n,
            data: {
              ...n.data,
              ...(n.data.kind === "text"
                ? { composer: nextConfig }
                : { mediaComposer: { ...mediaComposerOf(n), ...nextConfig } }),
            },
          };
        }),
      nextEdges = edgesRef.current.filter(
        (e) => !e.selected && !ids.has(e.source) && !ids.has(e.target),
      );
    setNodes(next);
    setEdges(nextEdges);
    commit(next, nextEdges);
    root.current?.focus({ preventScroll: true });
  }
  function openAdd(x?: number, y?: number) {
    const rect = root.current!.getBoundingClientRect();
    setMenu({
      x: x ?? rect.left + 80,
      y: y ?? rect.top + 150,
      point:
        x !== undefined && y !== undefined
          ? flow.screenToFlowPosition({ x, y })
          : center(),
    });
    setPanel(null);
  }
  async function files(list: File[], point?: XYPosition, targetId?: string) {
    if (uploadAbort.current || !list.length) return;
    const controller = new AbortController();
    uploadAbort.current = controller;
    setError("");
    try {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        setProgress(p.t("uploading") + " 0%");
        const media = await upload(
          p.request,
          project.id,
          f,
          (n) => setProgress(p.t("uploading") + " " + n + "%"),
          controller.signal,
        );
        controller.signal.throwIfAborted();
        if (p.editor.current?.id !== project.id) return;
        const kind = media.mime.startsWith("video/") ? "video" : "image";
        const target = i === 0 ? targetId : undefined;
        if (target) {
          const next = nodesRef.current.map((n) =>
            n.id === target
              ? {
                  ...n,
                  data: {
                    kind,
                    label: f.name,
                    text: "",
                    media,
                  } as CreativeNode["data"],
                }
              : n,
          );
          setNodes(next);
          commit(next);
        } else
          add(
            kind,
            point ? { x: point.x + i * 40, y: point.y + i * 40 } : center(),
            { label: f.name, media },
          );
        await p.editor.flush();
      }
      p.notify(p.t("uploaded"));
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      uploadAbort.current = null;
      setProgress("");
    }
  }
  const pick = (id?: string, point = center()) => {
    if (uploadAbort.current) return;
    uploadDestination.current = { target: id, point: { ...point } };
    input.current?.click();
  };
  function changeNode(id: string, data: CreativeNode["data"], history = true) {
    const generationPreferences = rememberGeneration(
      p.editor.current?.generationPreferences,
      nodesRef.current.find((n) => n.id === id)?.data,
      data,
    );
    const next = nodesRef.current.map((n) =>
      n.id === id ? { ...n, data, draggable: true } : n,
    );
    const currentNode = {
      id,
      type: "creative" as const,
      position: { x: 0, y: 0 },
      data,
    };
    const refs =
      data.kind === "text"
        ? referenceIds(composerOf(currentNode))
        : mediaReferenceIds(mediaComposerOf(currentNode), next);
    const nextEdges = edgesRef.current.filter(
      (e) => !e.id.startsWith(`reference:${id}:`),
    );
    for (const source of refs) {
      if (
        next.some((n) => n.id === source) &&
        !nextEdges.some((e) => e.source === source && e.target === id)
      )
        nextEdges.push({ id: `reference:${id}:${source}`, source, target: id });
    }
    nodesRef.current = next;
    edgesRef.current = nextEdges;
    setNodes(next);
    setEdges(nextEdges);
    commit(next, nextEdges, history, { generationPreferences });
  }
  function chooseReference(id: string, targetId = picking?.target) {
    if (!targetId) return;
    const target = nodesRef.current.find((n) => n.id === targetId);
    if (!target) return;
    if (picking?.frameSlot && targetId === picking.target) {
      const source = nodesRef.current.find((n) => n.id === id);
      if (source?.data.kind !== "image") {
        p.notify(p.t("frameNeedsImage"));
        return;
      }
      const reason = framePickProblem(
        { nodes: nodesRef.current, edges: edgesRef.current },
        targetId,
        id,
      );
      if (reason) {
        p.notify(p.t(reason));
        return;
      }
      const composer = changeFrame(
        mediaComposerOf(target),
        nodesRef.current,
        picking.frameSlot,
        id,
      );
      changeNode(targetId, { ...target.data, mediaComposer: composer });
      setPicking(null);
      return;
    }
    const reason = referencePickProblem(
      { nodes: nodesRef.current, edges: edgesRef.current },
      targetId,
      id,
      picking?.images,
    );
    if (reason) {
      if (reason === "referenceAdded") return;
      p.notify(p.t(reason));
      return;
    }
    const config = composerOf(target);
    changeNode(targetId, {
      ...target.data,
      ...(target.data.kind === "text"
        ? {
            composer: { ...config, referenceIds: [...config.referenceIds, id] },
          }
        : {
            mediaComposer: {
              ...mediaComposerOf(target),
              referenceIds: [...config.referenceIds, id],
            },
          }),
    });
  }
  const editing = (el: EventTarget | null) =>
    el instanceof Element &&
    !!el.closest(
      'input,textarea,[contenteditable="true"],[role="dialog"]:not([data-studio-surface]),[data-studio-agent],[data-studio-assets],[role="menu"],[data-project-switcher],[data-text-composer],[data-studio-viewport],[data-studio-player],video,.react-flow__controls',
    );
  return (
    <div
      className={css.canvas}
      ref={root}
      tabIndex={0}
      data-studio-canvas
      onKeyDownCapture={(e) => {
        if (
          (e.target as Element).closest(
            '[role="dialog"]:not([data-studio-surface]), [data-studio-agent],[data-studio-assets],[role="menu"],[data-project-switcher],[data-text-composer]',
          )
        )
          return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (picking) setPicking(null);
          else if (editingText) setEditingText(undefined);
          else if (menu) setMenu(null);
          else if (panel) setPanel(null);
          else setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
          root.current?.focus({ preventScroll: true });
          return;
        }
        if (editing(e.target)) return;
        if (e.metaKey || e.ctrlKey) {
          if (e.key.toLowerCase() === "z") {
            e.preventDefault();
            e.stopPropagation();
            e.shiftKey ? p.editor.redo() : p.editor.undo();
          } else if (e.key.toLowerCase() === "d") {
            e.preventDefault();
            duplicate();
          } else if (e.key.toLowerCase() === "c") {
            clipboard.current = {
              nodes: nodesRef.current.filter((n) => n.selected),
              edges: edgesRef.current,
            };
          }
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          remove();
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          void files(
            Array.from(e.dataTransfer.files),
            flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
          );
        }
      }}
      onPaste={(e) => {
        if (editing(e.target)) return;
        const f = Array.from(e.clipboardData.files);
        if (f.length) {
          e.preventDefault();
          void files(f);
        } else if (clipboard.current) {
          e.preventDefault();
          paste();
        }
      }}
    >
      <NodeContext.Provider
        value={{
          request: p.request,
          projectId: project.id,
          t: p.t,
          pick,
          muted,
          setMuted,
          expand: (id, start) => {
            const node = nodesRef.current.find((n) => n.id === id);
            if (node) expand(node, start);
          },
          jobs: (id) =>
            latestBatch(
              [
                ...textJobs.jobs.map((j) => ({ ...j, kind: "text" as const })),
                ...mediaJobs.jobs,
              ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
              id,
            ),
          jobAction: (job, action) => {
            if (action === "configure") {
              if ("snapshot" in job && "connectionId" in job.snapshot)
                setMediaConfig(job.snapshot.connectionId);
              return;
            }
            void (
              "snapshot" in job && "baseText" in job.snapshot
                ? p
                    .request("generationAction", { id: job.id, action })
                    .then(textJobs.refresh)
                : p
                    .request("mediaJobAction", { id: job.id, action })
                    .then(mediaJobs.refresh)
            ).catch((e) => setError(e.message));
          },
          dimensions: (id) => {
            const node = nodesRef.current.find((n) => n.id === id);
            return { width: node?.width, height: node?.height };
          },
          resize: (id, rect) => {
            const next = nodesRef.current.map((n) =>
              n.id === id
                ? {
                    ...n,
                    position: { x: rect.x, y: rect.y },
                    width: rect.width,
                    height: rect.height,
                  }
                : n,
            );
            nodesRef.current = next;
            setNodes(next);
            commit(next);
          },
          referenceState: (id) => {
            if (!picking) return undefined;
            if (
              picking.frameSlot &&
              nodes.find((n) => n.id === id)?.data.kind !== "image"
            )
              return { invalid: p.t("frameNeedsImage") };
            const reason = (
              picking.frameSlot ? framePickProblem : referencePickProblem
            )({ nodes, edges }, picking.target, id, picking.images);
            return {
              invalid: reason ? p.t(reason) : undefined,
            };
          },
        }}
      >
        <ReactFlow<FlowNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultViewport={project.viewport}
          minZoom={0.1}
          maxZoom={3}
          deleteKeyCode={null}
          panOnDrag
          nodesDraggable={!picking}
          nodesConnectable={!picking}
          connectionRadius={56}
          connectOnClick
          isValidConnection={(connection) =>
            !referencePickProblem(
              { nodes: nodesRef.current, edges: edgesRef.current },
              connection.target,
              connection.source,
            )
          }
          onConnectEnd={(event, connection) => {
            if (
              picking ||
              connection.isValid ||
              !connection.fromNode ||
              !connection.fromHandle
            )
              return;
            const pointer =
              "changedTouches" in event ? event.changedTouches[0] : event;
            if (!pointer) return;
            const at = flow.screenToFlowPosition({
              x: pointer.clientX,
              y: pointer.clientY,
            });
            const hit = [...nodesRef.current].reverse().find((n) => {
              if (n.id === connection.fromNode!.id) return false;
              const width = n.measured?.width ?? n.width ?? 270;
              const height = n.measured?.height ?? n.height ?? 152;
              return (
                at.x >= n.position.x - 12 &&
                at.x <= n.position.x + width + 12 &&
                at.y >= n.position.y - 12 &&
                at.y <= n.position.y + height + 12
              );
            });
            if (!hit) return;
            const target =
              connection.fromHandle.type === "source"
                ? hit.id
                : connection.fromNode.id;
            const source =
              connection.fromHandle.type === "source"
                ? connection.fromNode.id
                : hit.id;
            chooseReference(source, target);
          }}
          elementsSelectable={!picking}
          onNodeClick={(event, n) => {
            if (picking) chooseReference(n.id);
            else if (!event.shiftKey)
              setNodes((old) =>
                old.map((item) => ({ ...item, selected: item.id === n.id })),
              );
          }}
          selectionOnDrag={false}
          selectionKeyCode="Shift"
          multiSelectionKeyCode="Shift"
          panActivationKeyCode="Space"
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          zoomActivationKeyCode={["Meta", "Control"]}
          zoomOnDoubleClick={false}
          onNodesChange={(changes) =>
            setNodes((ns) =>
              applyNodeChanges(
                picking ? changes.filter((c) => c.type !== "select") : changes,
                ns,
              ),
            )
          }
          onEdgesChange={(changes) =>
            setEdges((es) => applyEdgeChanges(changes, es))
          }
          onNodeDragStop={(_, __, ns) => {
            const moved = new Map(ns.map((n) => [n.id, n.position]));
            const next = nodesRef.current.map((n) =>
              moved.has(n.id) ? { ...n, position: moved.get(n.id)! } : n,
            );
            setNodes(next);
            commit(next);
          }}
          onConnect={(c) => {
            if (c.source === c.target) return;
            if (nodesRef.current.some((n) => n.id === c.target)) {
              chooseReference(c.source, c.target);
              return;
            }
            const visit = (id: string, seen = new Set<string>()): boolean => {
              if (id === c.source) return true;
              if (seen.has(id)) return false;
              seen.add(id);
              return edgesRef.current
                .filter((e) => e.source === id)
                .some((e) => visit(e.target, seen));
            };
            if (visit(c.target)) {
              setError(p.t("cycle"));
              return;
            }
            if (
              edges.some((e) => e.source === c.source && e.target === c.target)
            )
              return;
            const next = [
              ...edgesRef.current,
              { id: crypto.randomUUID(), source: c.source, target: c.target },
            ];
            setEdges(next);
            commit(nodesRef.current, next);
          }}
          onMove={(_, viewport) => setZoom(viewport.zoom)}
          onMoveEnd={(_, viewport) => {
            setZoom(viewport.zoom);
            if (
              JSON.stringify(viewport) !==
              JSON.stringify(p.editor.current!.viewport)
            )
              p.editor.change({ ...p.editor.current!, viewport }, false);
          }}
          onPaneClick={() => {
            setMenu(null);
            root.current?.focus({ preventScroll: true });
          }}
          onNodeDoubleClick={(event, n) => {
            if (picking) return;
            if (n.data.kind === "text") {
              setEditingText(n.id);
              return;
            }
            if (n.data.media || n.data.asset) {
              event.preventDefault();
              (event.target as Element)
                .closest(".react-flow__node")
                ?.querySelector("video")
                ?.pause();
              expand(
                n,
                (event.target as Element)
                  .closest(".react-flow__node")
                  ?.querySelector("video")?.currentTime,
              );
            }
          }}
          onDoubleClick={(e) => {
            if (picking) return;
            if (
              !(e.target as Element).closest(
                ".react-flow__node,.react-flow__edge,.react-flow__panel",
              )
            ) {
              e.preventDefault();
              openAdd(e.clientX, e.clientY);
            }
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          {minimap && <CanvasMinimap label={p.t("minimap")} />}
        </ReactFlow>
      </NodeContext.Provider>
      <ProjectSwitcher {...p} />
      {picking && (
        <div className={css.referencePickBar} role="status">
          <span>{p.t("pickReference")}</span>
          <Button onClick={() => setPicking(null)}>
            {p.t("done")} <kbd>Esc</kbd>
          </Button>
        </div>
      )}
      <div className={css.topActions}>
        <span className={css.saveState} data-error={state.status === "error"}>
          {p.t(
            state.status === "error"
              ? "unsaved"
              : state.status === "saving"
                ? "saving"
                : "saved",
          )}
        </span>
        <Button
          className={css.assistantTrigger}
          data-active={panel === "assistant"}
          onClick={() => setPanel(panel === "assistant" ? null : "assistant")}
        >
          <Icon name="chat" />
          {p.t("assistant")}
        </Button>
      </div>
      <div className={css.rail}>
        <Tool
          label={p.t("add")}
          icon="plus"
          active={!!menu}
          onClick={() => (menu ? setMenu(null) : openAdd())}
        />
        <span className={css.railDivider} />
        <Tool
          label={p.t("assets")}
          icon="folder"
          active={panel === "assets"}
          onClick={() => {
            setMenu(null);
            setAssetDraft(undefined);
            assetPoint.current = center();
            setPanel(panel === "assets" ? null : "assets");
          }}
        />
        <Tool
          label={p.t("templates")}
          icon="grid"
          active={templatesOpen}
          onClick={() => {
            setMenu(null);
            setTemplatesOpen(true);
          }}
        />
        <Tool
          label={p.t("assistant")}
          icon="chat"
          active={panel === "assistant"}
          onClick={() => setPanel(panel === "assistant" ? null : "assistant")}
        />
      </div>
      <div className={css.viewportBar} data-studio-viewport>
        <Tool
          label={p.t("minimap")}
          icon="map"
          side="top"
          active={minimap}
          onClick={() => setMinimap(!minimap)}
        />
        <span className={css.pillDivider} />
        <Tool
          label={p.t("fit")}
          icon="fit"
          side="top"
          onClick={() =>
            void flow.fitView({ padding: 0.25, duration: 200, maxZoom: 1 })
          }
        />
        <input
          type="range"
          className={css.zoomSlider}
          aria-label={p.t("zoom")}
          min={0}
          max={100}
          step={1}
          value={Math.round((Math.log(zoom / 0.1) / Math.log(30)) * 100)}
          aria-valuetext={`${Math.round(zoom * 100)}%`}
          onChange={(e) =>
            void flow.zoomTo(0.1 * 30 ** (Number(e.target.value) / 100))
          }
        />
        <Tooltip label={p.t("actualSize")} side="top" portal>
          <Button
            className={css.zoom}
            onClick={() => void flow.zoomTo(1, { duration: 180 })}
          >
            {Math.round(zoom * 100)}%
          </Button>
        </Tooltip>
        <span className={css.pillDivider} />
        <Tool
          label={p.t("undo")}
          icon="undo"
          side="top"
          disabled={!state.canUndo}
          onClick={() => p.editor.undo()}
        />
        <Tool
          label={p.t("redo")}
          icon="redo"
          side="top"
          disabled={!state.canRedo}
          onClick={() => p.editor.redo()}
        />
      </div>
      <div className={css.helpButton}>
        <Tool
          label={p.t("help")}
          icon="help"
          side="top"
          onClick={() => setHelp(!help)}
        />
      </div>
      {help && (
        <div className={css.helpPopup}>
          <strong>{p.t("canvasGestures")}</strong>
          <dl>
            {(
              [
                ["dragCanvas", "moveCanvas"],
                ["trackpadPan", "moveCanvas"],
                ["trackpadZoom", "zoom"],
                ["wheelZoom", "zoom"],
                ["dragSelection", "selectArea"],
                ["doubleClick", "add"],
              ] as [Key, Key][]
            ).map(([gesture, action]) => (
              <div key={gesture}>
                <dt>{p.t(gesture)}</dt>
                <dd>{p.t(action)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <Modal
        open={templatesOpen}
        title={p.t("templates")}
        closeLabel={p.t("close")}
        onClose={() => setTemplatesOpen(false)}
        className={css.templateLibraryDialog}
        contentClassName={css.templateLibraryDialogContent}
      >
        {templatesOpen && (
          <TemplateLibrary
            p={p}
            onUse={async (template) => {
              add(
                "image",
                center(),
                templateNodeData(p.editor.current!, template),
              );
              await p.editor.flush();
              setTemplatesOpen(false);
            }}
          />
        )}
      </Modal>
      {!nodes.length && !menu && (
        <div className={css.canvasEmpty}>
          <div>
            <Icon name="sparkle" size={34} />
          </div>
          <h2>{p.t("emptyCanvas")}</h2>
          <p>{p.t("emptyCanvasSub")}</p>
          <Button variant="outline" onClick={() => openAdd()}>
            <Icon name="plus" />
            {p.t("add")}
          </Button>
        </div>
      )}
      {menu && (
        <div
          className={css.addAnchor}
          style={{
            left: menu.x - (root.current?.getBoundingClientRect().left ?? 0),
            top: menu.y - (root.current?.getBoundingClientRect().top ?? 0),
          }}
        >
          <Menu
            open
            onClose={() => setMenu(null)}
            autoFocus
            portal
            listClassName={css.addMenu}
            getAnchorRect={() => new DOMRect(menu.x, menu.y, 0, 0)}
            anchor={<span />}
            items={[
              { type: "label", id: "nodes-heading", text: p.t("add") },
              { id: "text", label: p.t("text"), icon: <Icon name="text" /> },
              { id: "image", label: p.t("image"), icon: <Icon name="image" /> },
              { id: "video", label: p.t("video"), icon: <Icon name="video" /> },
              { type: "separator", id: "resources-divider" },
              {
                type: "label",
                id: "resources-heading",
                text: p.t("addResources"),
              },
              {
                id: "upload",
                label: p.t("upload"),
                icon: <Icon name="upload" />,
                disabled: !!progress,
              },
              {
                id: "assets",
                label: p.t("assets"),
                icon: <Icon name="folder" />,
              },
            ]}
            onSelect={(id) => {
              if (id === "upload") {
                pick(undefined, menu.point);
                setMenu(null);
              } else if (id === "assets") {
                assetPoint.current = { ...menu.point };
                setAssetDraft(undefined);
                setPanel("assets");
                setMenu(null);
              } else add(id as "text" | "image" | "video");
            }}
          />
        </div>
      )}
      {panel === "assets" && (
        <AssetLibrary
          p={p}
          onClose={() => {
            setPanel(null);
            setAssetDraft(undefined);
            root.current?.focus({ preventScroll: true });
          }}
          onAdd={(references, item) => {
            references.forEach((ref) =>
              add(
                ref.kind,
                assetPoint.current ?? center(),
                {
                  ...ref,
                  label: (ref.media ?? ref.asset)!.name,
                  text: item?.description ?? "",
                  creativeAssetId: item?.id,
                },
                false,
              ),
            );
            commit(nodesRef.current);
            void p.editor
              .flush()
              .then(() => p.notify(p.t("uploaded")))
              .catch((e) => setError(e.message));
          }}
        />
      )}
      {assetDraft && (
        <SaveCreativeResources
          p={p}
          resources={assetDraft}
          onClose={() => setAssetDraft(undefined)}
        />
      )}
      {panel === "assistant" && (
        <section
          className={css.agentPanel}
          data-studio-agent
          aria-label={p.t("assistant")}
        >
          <header>
            <strong>
              <Icon name="sparkle" />
              {p.t("assistant")}
            </strong>
            <Tool
              label={p.t("close")}
              icon="close"
              onClick={() => setPanel(null)}
            />
          </header>
          <div className={css.agentContent}>
            {agent ? (
              <p.SessionProvider session={agent}>
                {p.renderSlot("creative.agent", {})}
              </p.SessionProvider>
            ) : (
              <div className={css.agentLoading}>
                {agentError ? (
                  <span role="alert">{agentError}</span>
                ) : (
                  p.t("opening")
                )}
              </div>
            )}
          </div>
        </section>
      )}
      {selectedCount > 1 &&
        !panel &&
        nodes.some((n) => n.selected && (n.data.media || n.data.asset)) && (
          <section className={css.inspector}>
            <footer>
              <span>
                {selectedCount} {p.t("selected")}
              </span>
              <Button
                variant="outline"
                onClick={() => {
                  const refs = nodes
                    .filter(
                      (n) =>
                        n.selected &&
                        n.data.kind !== "text" &&
                        (n.data.media || n.data.asset),
                    )
                    .map((n) => ({
                      kind: n.data.kind as "image" | "video",
                      media: n.data.media,
                      asset: n.data.asset,
                    }));
                  if (refs.length > 24) {
                    p.notify(p.t("referenceLimit"));
                    return;
                  }
                  setAssetDraft(refs);
                  setPanel(null);
                }}
              >
                <Icon name="folder" size={17} />
                {p.t("saveSelection")}
              </Button>
            </footer>
          </section>
        )}
      {selected?.data.kind === "text" &&
        selectedCount === 1 &&
        !panel &&
        !editingText && (
          <NodePanel node={selected} root={root}>
            <TextComposer
              key={`composer:${selected.id}`}
              p={p}
              project={project}
              node={selected}
              jobs={textJobs.jobs}
              picking={picking?.target === selected.id}
              onPicking={(value) => {
                setPicking(value);
                setEditingText(undefined);
              }}
              onChange={(data) => changeNode(selected.id, data)}
              onRefresh={textJobs.refresh}
            />
          </NodePanel>
        )}
      {selected &&
        selected.data.kind !== "text" &&
        selectedCount === 1 &&
        !panel && (
          <NodePanel node={selected} root={root}>
            <MediaComposer
              key={`media-composer:${selected.id}:${mediaConfigRevision}`}
              p={p}
              project={project}
              node={selected}
              jobs={mediaJobs.jobs}
              picking={picking?.target === selected.id}
              pickingSlot={
                picking?.target === selected.id ? picking.frameSlot : undefined
              }
              onPicking={setPicking}
              onChange={(data) => changeNode(selected.id, data)}
              onRefresh={mediaJobs.refresh}
              prepareTarget={async (config) => {
                const original = nodesRef.current.find(
                  (n) => n.id === selected.id,
                );
                if (!original || isGenerationNode(original)) return selected.id;
                const composer = continuationComposer(original, config);
                const output = add(
                  original.data.kind,
                  {
                    x:
                      original.position.x +
                      (original.measured?.width ?? 270) +
                      80,
                    y: original.position.y,
                  },
                  { mediaComposer: composer },
                  false,
                );
                changeNode(output.id, output.data);
                await p.editor.flush();
                return output.id;
              }}
              onSubmitError={setError}
              onJobAction={(job, action) => {
                if (action === "configure") {
                  setMediaConfig(job.snapshot.connectionId);
                  return;
                }
                void p
                  .request("mediaJobAction", { id: job.id, action })
                  .then(mediaJobs.refresh)
                  .catch((e) => setError(e.message));
              }}
            />
          </NodePanel>
        )}
      {selected &&
        !picking &&
        !editingText &&
        selectedCount === 1 &&
        !panel && (
          <NodePanel node={selected} root={root} above>
            <nav
              className={css.nodeActionBar}
              aria-label={p.t("resourceActions")}
            >
              <PinPicker
                t={p.t}
                colors={selected.data.colorPins}
                onChange={(colorPins) =>
                  changeNode(selected.id, { ...selected.data, colorPins })
                }
              />
              <Tool
                label={p.t("saveSelection")}
                icon="folder"
                disabled={!selected.data.media && !selected.data.asset}
                onClick={() => {
                  setAssetDraft([
                    {
                      kind: selected.data.kind as "image" | "video",
                      media: selected.data.media,
                      asset: selected.data.asset,
                    },
                  ]);
                  setPanel(null);
                }}
              />
              <Tool
                label={p.t("downloadOriginal")}
                icon="download"
                disabled={
                  selected.data.kind === "text" ||
                  (!selected.data.media && !selected.data.asset)
                }
                onClick={() => {
                  void downloadMedia(
                    p.request,
                    project.id,
                    selected.data,
                  ).catch((e) => setError(e.message));
                }}
              />
              <Tool
                label={p.t("previewTitle")}
                icon="fit"
                disabled={
                  selected.data.kind !== "text" &&
                  !selected.data.media &&
                  !selected.data.asset
                }
                onClick={() => {
                  if (selected.data.kind === "text")
                    setEditingText(selected.id);
                  else expand(selected);
                }}
              />
            </nav>
          </NodePanel>
        )}
      {(error ||
        state.error ||
        textJobs.error ||
        mediaJobs.error ||
        progress) && (
        <div className={css.canvasMessage} role={progress ? "status" : "alert"}>
          <span>
            {progress ||
              error ||
              state.error ||
              textJobs.error ||
              mediaJobs.error}
          </span>
          {state.status === "error" && (
            <>
              <Button
                size="sm"
                onClick={() => void p.editor.flush().catch(() => {})}
              >
                {p.t("retry")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const u = URL.createObjectURL(
                    new Blob([JSON.stringify(p.editor.current, null, 2)], {
                      type: "application/json",
                    }),
                  );
                  const a = document.createElement("a");
                  a.href = u;
                  a.download = project.name + ".json";
                  a.click();
                  URL.revokeObjectURL(u);
                }}
              >
                {p.t("exportDraft")}
              </Button>
            </>
          )}
          {error && (
            <Tool
              label={p.t("close")}
              icon="close"
              onClick={() => setError("")}
            />
          )}
        </div>
      )}
      <input
        hidden
        ref={input}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
        onChange={(e) => {
          const destination = uploadDestination.current;
          uploadDestination.current = undefined;
          void files(
            Array.from(e.target.files ?? []),
            destination?.point,
            destination?.target,
          );
          e.target.value = "";
        }}
      />
      {preview && (
        <MediaPreview
          p={p}
          projectId={project.id}
          data={preview.data}
          start={previewStart}
          muted={muted}
          onMutedChange={setMuted}
          onClose={() => setPreview(null)}
          onSave={() => {
            setAssetDraft([
              {
                kind: preview.data.kind as "image" | "video",
                media: preview.data.media,
                asset: preview.data.asset,
              },
            ]);
            setPanel(null);
            setPreview(null);
          }}
        />
      )}
      {mediaConfig && (
        <Modal
          open
          title={p.t("checkMediaSettings")}
          closeLabel={p.t("close")}
          className={css.modelDiscoveryDialog}
          onClose={() => {
            setMediaConfig(undefined);
            setMediaConfigRevision((v) => v + 1);
          }}
        >
          <MediaSettings {...p} initialConnection={mediaConfig} />
        </Modal>
      )}
      {editingText &&
        nodes.find((n) => n.id === editingText)?.data.kind === "text" && (
          <MarkdownEditor
            key={`markdown:${editingText}`}
            p={p}
            label={nodes.find((n) => n.id === editingText)!.data.label}
            value={nodes.find((n) => n.id === editingText)!.data.text}
            onChange={(text, history) => {
              const n = nodesRef.current.find((n) => n.id === editingText);
              if (n) changeNode(n.id, { ...n.data, text }, history);
            }}
            onClose={() => {
              setEditingText(undefined);
              void p.editor.flush().catch(() => {});
            }}
          />
        )}
    </div>
  );
}

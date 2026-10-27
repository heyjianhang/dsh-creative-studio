import { useEffect, useRef, useState } from "react";
import { Button, Menu, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  CreativeNode,
  Project,
  Generation,
  ModelCatalog,
  TextComposerState,
} from "../shared/contracts.ts";
import {
  composerOf,
  referenceIds,
  referenceProblem,
  connectedReferences,
} from "../shared/text-generation.ts";
import type { Shared } from "./props.ts";
import { TextModelPicker } from "./text-model-picker.tsx";
import { PromptEditor } from "./prompt-editor.tsx";
import {
  ReferenceHoverPreview,
  type ReferenceHover,
} from "./reference-hover-preview.tsx";
import { MediaView } from "./media.tsx";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";
import { GenerationSend } from "./generation-send.tsx";

export type ReferencePicking = {
  target: string;
  images: "yes" | "no" | "unknown";
  frameSlot?: "first" | "last";
};
type Props = {
  p: Shared;
  project: Project;
  node: CreativeNode;
  jobs: Generation[];
  picking: boolean;
  onPicking(value: ReferencePicking | null): void;
  onChange(data: CreativeNode["data"]): void;
  onRefresh(): Promise<void>;
};
export function TextComposer({
  p,
  project,
  node,
  jobs,
  picking,
  onPicking,
  onChange,
  onRefresh,
}: Props) {
  const config = composerOf(node);
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [catalogError, setCatalogError] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [countOpen, setCountOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [hoverRef, setHoverRef] = useState<ReferenceHover>();
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [load, setLoad] = useState(0);
  const submitting = useRef(false);
  const requestId = useRef<string>();
  const mounted = useRef(true);
  const latest = useRef({ config, node });
  latest.current = { config, node };
  const selection = config.selection ?? catalog?.default;
  const model = catalog?.models.find(
    (m) => m.provider === selection?.provider && m.model === selection?.model,
  );
  const images =
    catalog?.imagesAvailable === false ? "no" : (model?.images ?? "unknown");
  const refs = referenceIds(config);
  const referenceKey = refs.join("\n");
  const candidates = connectedReferences(project, node.id, images);
  const problems = refs
    .map((id) => referenceProblem(project, node.id, id, images))
    .filter(Boolean);
  const currentJobs = jobs.filter((j) => j.nodeId === node.id);
  const busy = currentJobs.some(
    (j) => j.status === "running" || j.status === "queued",
  );
  const preview = project.nodes.find((n) => n.id === hoverRef?.id);
  const showReference = (
    id?: string,
    anchor?: HTMLElement,
    showName = false,
  ) => {
    setHoverRef((previous) => {
      if (!id || !anchor) return undefined;
      if (
        previous?.id === id &&
        previous.anchor === anchor &&
        previous.showName === showName
      )
        return previous;
      return { id, anchor, showName };
    });
  };
  useEffect(() => {
    setThumbnails((previous) => {
      const retained = Object.fromEntries(
        Object.entries(previous).filter(([id]) => refs.includes(id)),
      );
      return Object.keys(retained).length === Object.keys(previous).length
        ? previous
        : retained;
    });
  }, [referenceKey]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setCatalogError("");
    void p
      .request("textModels", {}, abort.signal)
      .then(setCatalog)
      .catch((e) => {
        if (!abort.signal.aborted) setCatalogError(e.message);
      });
    return () => abort.abort();
  }, [load, p.request]);
  useEffect(() => {
    if (picking) onPicking({ target: node.id, images });
  }, [images]);
  const update = (partial: Partial<TextComposerState>) => {
    const n =
      p.editor.current?.nodes.find((n) => n.id === node.id) ??
      latest.current.node;
    onChange({ ...n.data, composer: { ...composerOf(n), ...partial } });
    requestId.current = undefined;
    setError("");
  };
  const removeReference = (id: string) =>
    update({
      referenceIds: config.referenceIds.filter((x) => x !== id),
      prompt: config.prompt.filter(
        (x) => x.type !== "reference" || x.nodeId !== id,
      ),
    });
  const submit = async () => {
    if (submitting.current || busy || !selection || problems.length) return;
    if (!config.prompt.some((x) => x.type === "text" && x.text.trim())) {
      setError(p.t("instructionRequired"));
      return;
    }
    if (
      config.prompt.reduce(
        (n, part) =>
          n + (part.type === "text" ? part.text.length : part.label.length),
        0,
      ) > 30000
    ) {
      setError(p.t("instructionLimit"));
      return;
    }
    submitting.current = true;
    setPending(true);
    setError("");
    onPicking(null);
    try {
      // Capture the chosen default so a host setting change cannot alter this request.
      if (!latest.current.config.selection) update({ selection });
      await p.editor.flush();
      const current = p.editor.current;
      if (!current || current.id !== project.id || !mounted.current) return;
      requestId.current ??= crypto.randomUUID();
      await p.request("generateText", {
        projectId: project.id,
        nodeId: node.id,
        revision: current.revision,
        requestId: requestId.current,
      });
      requestId.current = undefined;
      await onRefresh();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const action = async (job: Generation, value: "cancel" | "retry") => {
    try {
      await p.request("generationAction", { id: job.id, action: value });
      await onRefresh();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  };
  const tool = (label: string, icon: "undo", click: () => void) => (
    <Tooltip label={label}>
      <Button aria-label={label} className={css.tool} onClick={click}>
        <Icon name={icon} size={18} />
      </Button>
    </Tooltip>
  );
  return (
    <section
      className={css.textComposer}
      data-text-composer
      aria-label={p.t("textGeneration")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && picking) {
          e.preventDefault();
          onPicking(null);
        }
        e.stopPropagation();
      }}
    >
      <div className={css.referenceStrip}>
        {refs.map((id, i) => {
          const n = project.nodes.find((n) => n.id === id);
          const reason = referenceProblem(project, node.id, id, images);
          return (
            <div
              className={css.referenceTile}
              key={id}
              data-invalid={!!reason}
              onMouseEnter={(e) => showReference(id, e.currentTarget, true)}
              onMouseLeave={() => setHoverRef(undefined)}
            >
              <button
                type="button"
                aria-label={`${p.t("reference")} ${i + 1} · ${n?.data.label ?? p.t("referenceMissing")}`}
                onFocus={(e) => showReference(id, e.currentTarget, true)}
                onBlur={() => setHoverRef(undefined)}
                title={reason ? p.t(reason) : undefined}
              >
                {n?.data.kind === "image" ? (
                  <MediaView
                    request={p.request}
                    projectId={project.id}
                    data={n.data}
                    preview
                    onReady={({ src }) =>
                      setThumbnails((previous) =>
                        previous[id] === src
                          ? previous
                          : { ...previous, [id]: src },
                      )
                    }
                  />
                ) : (
                  <Icon name="text" size={22} />
                )}
                <small>{i + 1}</small>
              </button>
              <button
                type="button"
                className={css.removeReference}
                aria-label={p.t("removeReference")}
                onClick={() => removeReference(id)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
        <Tooltip label={p.t("pickReference")}>
          <Button
            className={css.addReference}
            aria-label={p.t("pickReference")}
            aria-pressed={picking}
            disabled={refs.length >= 12 && !picking}
            onClick={() =>
              onPicking(picking ? null : { target: node.id, images })
            }
          >
            <Icon name="plus" size={22} />
          </Button>
        </Tooltip>
        {!refs.length && (
          <span className={css.referenceHint}>{p.t("textReferenceHint")}</span>
        )}
      </div>
      {preview && hoverRef && (
        <ReferenceHoverPreview
          hover={hoverRef}
          node={preview}
          thumbnail={thumbnails[preview.id]}
          request={p.request}
          projectId={project.id}
        />
      )}
      <PromptEditor
        request={p.request}
        projectId={project.id}
        thumbnails={thumbnails}
        value={config.prompt}
        candidates={candidates}
        placeholder={p.t("generationPlaceholder")}
        emptyLabel={p.t("noReferences")}
        onReferenceHover={showReference}
        focusAfterPicking={picking}
        limitLabel={p.t("instructionLimit")}
        onChange={(prompt) => update({ prompt })}
        onSubmit={() => void submit()}
        onError={setError}
      />
      {(error || problems.length > 0 || catalogError) && (
        <div className={css.composerError} role="alert">
          {error || (problems[0] ? p.t(problems[0]) : catalogError)}
          {catalogError && (
            <Button size="sm" onClick={() => setLoad((n) => n + 1)}>
              {p.t("retry")}
            </Button>
          )}
        </div>
      )}
      <footer className={css.composerFooter}>
        <div className={css.composerModel}>
          <Menu
            open={modelOpen}
            onClose={() => setModelOpen(false)}
            listClassName={css.textModelMenu}
            side="top"
            align="start"
            portal
            anchor={
              <Button
                className={css.modelTrigger}
                onClick={() => {
                  setCountOpen(false);
                  setVersionsOpen(false);
                  setModelOpen(!modelOpen);
                }}
                aria-haspopup="menu"
                aria-expanded={modelOpen}
              >
                <Icon name="sparkle" size={18} />
                <span>
                  {model?.name ||
                    selection?.model ||
                    p.t(catalog ? "modelMissing" : "opening")}
                </span>
                <Icon name="down" size={14} />
              </Button>
            }
          >
            {modelOpen && (
              <TextModelPicker
                p={p}
                catalog={catalog}
                selection={selection}
                onRetry={() => setLoad((n) => n + 1)}
                onSelect={(value) => {
                  update({
                    selection: { provider: value.provider, model: value.model },
                  });
                  setModelOpen(false);
                }}
              />
            )}
          </Menu>
          {!!node.data.textVersions?.length && (
            <Menu
              open={versionsOpen}
              onClose={() => setVersionsOpen(false)}
              listClassName={css.textModelMenu}
              side="top"
              portal
              anchor={tool(p.t("textHistory"), "undo", () =>
                setVersionsOpen(!versionsOpen),
              )}
              items={[...node.data.textVersions]
                .reverse()
                .map((v, i) => ({ id: String(i), label: v.text.slice(0, 60) }))}
              onSelect={(id) => {
                const v = [...node.data.textVersions!].reverse()[Number(id)];
                if (!v) return;
                onChange({
                  ...node.data,
                  text: v.text,
                  textVersions: [
                    ...node.data.textVersions!,
                    {
                      text: node.data.text,
                      createdAt: new Date().toISOString(),
                    },
                  ]
                    .filter((v) => v.text)
                    .slice(-20),
                });
                setVersionsOpen(false);
              }}
            />
          )}
        </div>
        <div className={css.generationActions}>
          <Menu
            open={countOpen}
            onClose={() => setCountOpen(false)}
            side="top"
            align="end"
            portal
            listClassName={css.generationCountMenu}
            selection="fill"
            items={([4, 3, 2, 1] as const).map((count) => ({
              id: String(count),
              label: `${count}×`,
            }))}
            selectedId={String(config.count)}
            onSelect={(id) => {
              update({ count: Number(id) as TextComposerState["count"] });
              setCountOpen(false);
            }}
            anchor={
              <Button
                className={css.generationCountTrigger}
                aria-label={`${p.t("generationCount")} · ${config.count}`}
                aria-haspopup="menu"
                aria-expanded={countOpen}
                data-active={countOpen}
                onClick={() => {
                  setModelOpen(false);
                  setVersionsOpen(false);
                  setCountOpen(!countOpen);
                }}
              >
                {config.count}×
              </Button>
            }
          />
          <GenerationSend
            active={busy}
            pending={pending}
            label={p.t(pending ? "preparing" : "generateText")}
            stopLabel={p.t("stop")}
            disabled={
              !selection ||
              !!problems.length ||
              !config.prompt.some(
                (part) => part.type === "text" && part.text.trim(),
              )
            }
            onSubmit={() => void submit()}
            onStop={() =>
              void Promise.all(
                currentJobs
                  .filter((job) => ["running", "queued"].includes(job.status))
                  .map((job) => action(job, "cancel")),
              )
            }
          />
        </div>
      </footer>
    </section>
  );
}

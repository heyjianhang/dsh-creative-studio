import { useEffect, useRef, useState } from "react";
import { Button, Menu, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  capabilities,
  mediaComposerOf,
  normalizeParameters,
  type CreativeNode,
  type Project,
  type MediaJob,
  type MediaCatalog,
  type MediaComposerState,
} from "../shared/contracts.ts";
import {
  connectedReferences,
  referenceIds,
} from "../shared/text-generation.ts";
import { GenerationSend } from "./generation-send.tsx";
import { resultComposer } from "../shared/media-results.ts";
import type { Shared } from "./props.ts";
import type { ReferencePicking } from "./text-composer.tsx";
import { PromptEditor } from "./prompt-editor.tsx";
import {
  ReferenceHoverPreview,
  type ReferenceHover,
} from "./reference-hover-preview.tsx";
import { TextModelPicker } from "./text-model-picker.tsx";
import { MediaView } from "./media.tsx";
import { ArrowsLeftRight } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { SpeakerHigh } from "@phosphor-icons/react/dist/csr/SpeakerHigh";
import { SpeakerSlash } from "@phosphor-icons/react/dist/csr/SpeakerSlash";
import { ProviderIcon } from "./provider-icon.tsx";
import { MediaParameterPanel, AspectIcon } from "./media-parameter-panel.tsx";
import {
  changeFrame,
  framesOf,
  mediaReferenceIds,
} from "../shared/media-reference.ts";
import { GenerationCard, latestBatch, jobActive } from "./generation-card.tsx";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";
export function MediaComposer({
  p,
  project,
  node,
  jobs,
  picking,
  pickingSlot,
  onPicking,
  onChange,
  onRefresh,
  onJobAction,
  prepareTarget,
  onSubmitError,
}: {
  p: Shared;
  project: Project;
  node: CreativeNode;
  jobs: MediaJob[];
  picking: boolean;
  pickingSlot?: "first" | "last";
  onPicking(v: ReferencePicking | null): void;
  onChange(data: CreativeNode["data"]): void;
  onRefresh(): Promise<void>;
  onJobAction(job: MediaJob, action: "cancel" | "retry" | "configure"): void;
  prepareTarget?(config: MediaComposerState): Promise<string>;
  onSubmitError?(message: string): void;
}) {
  const [catalog, setCatalog] = useState<MediaCatalog>(),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [modelOpen, setModelOpen] = useState(false),
    [paramsOpen, setParamsOpen] = useState(false),
    [countOpen, setCountOpen] = useState(false),
    [thumbnails, setThumbnails] = useState<Record<string, string>>({}),
    [hover, setHover] = useState<ReferenceHover>();
  const requestId = useRef<string>(),
    lock = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const c = new AbortController();
    void p
      .request("mediaModels", {}, c.signal)
      .then(setCatalog)
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => {
      mounted.current = false;
      c.abort();
    };
  }, [p.request]);
  const config = mediaComposerOf(node),
    modelId =
      config.modelId ??
      (node.data.kind === "image"
        ? catalog?.defaultImage
        : catalog?.defaultVideo) ??
      catalog?.models.find((m) => m.kind === node.data.kind)?.id;
  useEffect(() => {
    if (!node.data.generationResult || node.data.mediaComposer) return;
    const job = jobs.find((j) => j.result?.id === node.data.media?.id);
    if (job) onChange({ ...node.data, mediaComposer: resultComposer(job) });
  }, [node.id, node.data.media?.id, node.data.mediaComposer, jobs]);
  const model = catalog?.models.find((m) => m.id === modelId),
    cap = model ? capabilities(model) : undefined,
    parameters = model
      ? normalizeParameters(
          model,
          node.data.mediaComposer?.parameters,
          project.nodes.filter(
            (n) =>
              referenceIds(config).includes(n.id) && n.data.kind === "image",
          ).length,
        )
      : config.parameters;
  const refs = mediaReferenceIds(config, project.nodes),
    candidates = connectedReferences(project, node.id, "yes");
  const frameMode = node.data.kind === "video" && parameters.mode === "frames";
  const frames = framesOf(config, project.nodes);
  const displayedJobs = latestBatch(jobs, node.id).filter((job) =>
    ["failed", "uncertain", "cancelled"].includes(job.status),
  ) as MediaJob[];
  const busy = jobs.some(
    (j) =>
      j.nodeId === node.id &&
      ["queued", "running", "downloading"].includes(j.status),
  );
  const update = (patch: Partial<MediaComposerState>) => {
    const n = p.editor.current?.nodes.find((n) => n.id === node.id) ?? node;
    onChange({
      ...n.data,
      mediaComposer: {
        ...mediaComposerOf(n),
        modelId: model?.id,
        parameters,
        ...patch,
      },
    });
    requestId.current = undefined;
    setError("");
  };
  const showReference = (id?: string, anchor?: HTMLElement, showName = false) =>
    setHover(id && anchor ? { id, anchor, showName } : undefined);
  const submit = async () => {
    if (lock.current || busy || !model) return;
    lock.current = true;
    setPending(true);
    setError("");
    onPicking(null);
    try {
      const latest =
        p.editor.current?.nodes.find((n) => n.id === node.id) ?? node;
      if (
        config.modelId !== model.id ||
        JSON.stringify(config.parameters) !== JSON.stringify(parameters)
      )
        onChange({
          ...latest.data,
          mediaComposer: {
            ...mediaComposerOf(latest),
            modelId: model.id,
            parameters,
          },
        });
      await p.editor.flush();
      if (!mounted.current || p.editor.current?.id !== project.id) return;
      const targetId = prepareTarget
        ? await prepareTarget({
            ...mediaComposerOf(latest),
            modelId: model.id,
            parameters,
          })
        : node.id;
      requestId.current ??= crypto.randomUUID();
      await p.request("generateMedia", {
        projectId: project.id,
        nodeId: targetId,
        revision: p.editor.current.revision,
        requestId: requestId.current,
      });
      requestId.current = undefined;
      await onRefresh();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
      else onSubmitError?.((e as Error).message);
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  };
  const preview = project.nodes.find((n) => n.id === hover?.id);
  return (
    <section
      className={`${css.textComposer} ${css.mediaComposer}`}
      data-text-composer
      aria-label={p.t("mediaGeneration")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && picking) {
          e.preventDefault();
          onPicking(null);
        }
        e.stopPropagation();
      }}
    >
      <div className={css.referenceStrip}>
        {frameMode && (
          <>
            {(["first", "last"] as const).map((slot, index) => {
              const id = frames[slot];
              const n = project.nodes.find((n) => n.id === id);
              return (
                <div className={css.frameSlotGroup} key={slot}>
                  {index === 1 && (
                    <Tooltip label={p.t("swapFrames")} portal>
                      <Button
                        className={css.swapFrameButton}
                        aria-label={p.t("swapFrames")}
                        disabled={!frames.first || !frames.last}
                        onClick={() =>
                          update({
                            frames: { first: frames.last, last: frames.first },
                          })
                        }
                      >
                        <ArrowsLeftRight size={18} />
                      </Button>
                    </Tooltip>
                  )}
                  <div
                    className={`${css.referenceTile} ${css.frameTile}`}
                    onMouseEnter={(e) => {
                      if (id) showReference(id, e.currentTarget, true);
                    }}
                    onMouseLeave={() => setHover(undefined)}
                  >
                    <Tooltip
                      label={p.t(slot === "first" ? "firstFrame" : "lastFrame")}
                      portal
                    >
                      <button
                        type="button"
                        aria-label={p.t(
                          slot === "first" ? "firstFrame" : "lastFrame",
                        )}
                        aria-pressed={picking && pickingSlot === slot}
                        disabled={slot === "last" && !frames.first}
                        onClick={() =>
                          onPicking({
                            target: node.id,
                            images: "yes",
                            frameSlot: slot,
                          })
                        }
                      >
                        {n ? (
                          <MediaView
                            request={p.request}
                            projectId={project.id}
                            data={n.data}
                            preview
                            onReady={({ src }) =>
                              setThumbnails((old) =>
                                old[n.id] === src
                                  ? old
                                  : { ...old, [n.id]: src },
                              )
                            }
                          />
                        ) : (
                          <Icon name="plus" size={22} />
                        )}
                      </button>
                    </Tooltip>
                    {id && (
                      <button
                        className={css.removeReference}
                        aria-label={p.t("removeReference")}
                        onClick={() =>
                          update(changeFrame(config, project.nodes, slot))
                        }
                      >
                        <Icon name="close" size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}
        {refs
          .filter(
            (id) =>
              !frameMode ||
              project.nodes.find((n) => n.id === id)?.data.kind === "text",
          )
          .map((id, i) => {
            const n = project.nodes.find((n) => n.id === id);
            return (
              <div
                key={id}
                className={css.referenceTile}
                onMouseEnter={(e) => showReference(id, e.currentTarget, true)}
                onMouseLeave={() => setHover(undefined)}
              >
                <button
                  type="button"
                  aria-label={`${p.t("reference")} ${i + 1}`}
                  onFocus={(e) => showReference(id, e.currentTarget, true)}
                  onBlur={() => setHover(undefined)}
                >
                  {n?.data.kind === "image" ? (
                    <MediaView
                      request={p.request}
                      projectId={project.id}
                      data={n.data}
                      preview
                      onReady={({ src }) =>
                        setThumbnails((old) =>
                          old[id] === src ? old : { ...old, [id]: src },
                        )
                      }
                    />
                  ) : (
                    <Icon name="text" size={22} />
                  )}
                  <small>{i + 1}</small>
                </button>
                <button
                  className={css.removeReference}
                  aria-label={p.t("removeReference")}
                  onClick={() =>
                    update({
                      referenceIds: config.referenceIds.filter((v) => v !== id),
                      prompt: config.prompt.filter(
                        (v) => v.type !== "reference" || v.nodeId !== id,
                      ),
                    })
                  }
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            );
          })}
        {!frameMode && (
          <Tooltip label={p.t("pickReference")}>
            <Button
              className={css.addReference}
              aria-label={p.t("pickReference")}
              aria-pressed={picking}
              disabled={refs.length >= 12 && !picking}
              onClick={() =>
                onPicking(picking ? null : { target: node.id, images: "yes" })
              }
            >
              <Icon name="plus" size={22} />
            </Button>
          </Tooltip>
        )}
      </div>
      {preview && hover && (
        <ReferenceHoverPreview
          hover={hover}
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
        candidates={
          frameMode
            ? candidates.filter(
                (n) => n.data.kind === "text" || refs.includes(n.id),
              )
            : candidates
        }
        placeholder={p.t("generationPlaceholder")}
        emptyLabel={p.t("noReferences")}
        onReferenceHover={showReference}
        focusAfterPicking={picking}
        limitLabel={p.t("instructionLimit")}
        onChange={(prompt) => update({ prompt })}
        onSubmit={() => void submit()}
        onError={setError}
      />
      {error && (
        <div className={css.composerError} role="alert">
          {error}
        </div>
      )}
      {!!displayedJobs.length && (
        <GenerationCard
          jobs={displayedJobs}
          t={p.t}
          action={(job, action) => onJobAction(job as MediaJob, action)}
        />
      )}
      <footer className={css.composerFooter}>
        <div className={css.composerModel}>
          <Menu
            open={modelOpen}
            onClose={() => setModelOpen(false)}
            listClassName={`${css.textModelMenu} ${css.mediaModelMenu}`}
            portal
            side="top"
            anchor={
              <Button
                className={css.modelTrigger}
                onClick={() => {
                  setModelOpen(!modelOpen);
                  setParamsOpen(false);
                  setCountOpen(false);
                }}
              >
                <ProviderIcon model size={20} />
                <span>{model?.name ?? p.t("configureMedia")}</span>
                <Icon name="down" size={14} />
              </Button>
            }
          >
            {modelOpen && (
              <TextModelPicker
                p={p}
                searchable={false}
                renderModel={(item) => {
                  const entry = catalog?.models.find(
                    (m) => m.id === item.model,
                  );
                  const ability = entry && capabilities(entry);
                  return (
                    <span className={css.mediaModelOption}>
                      <span className={css.mediaModelName}>
                        <ProviderIcon model size={21} />
                        <strong>{item.name}</strong>
                        <small className={css.mediaModelProvider}>
                          {item.providerName}
                        </small>
                      </span>
                      <span className={css.mediaModelBadges}>
                        {ability && (
                          <small>{ability.resolutions.join(" / ")}</small>
                        )}
                        {ability?.kind === "video" && (
                          <small>
                            {ability.durations[0]}–{ability.durations.at(-1)}s
                          </small>
                        )}
                        {ability?.audio && (
                          <small aria-label={p.t("generateAudio")}>
                            <SpeakerHigh size={14} />
                          </small>
                        )}
                      </span>
                    </span>
                  );
                }}
                catalog={{
                  models:
                    catalog?.models
                      .filter((m) => m.kind === node.data.kind)
                      .map((m) => ({
                        provider: m.connectionId,
                        providerName: m.connectionName,
                        model: m.id,
                        name: m.name,
                        images: "yes" as const,
                      })) ?? [],
                  imagesAvailable: true,
                  failures: [],
                }}
                selection={
                  model
                    ? { provider: model.connectionId, model: model.id }
                    : undefined
                }
                onSelect={(s) => {
                  const next = catalog?.models.find((m) => m.id === s.model);
                  if (next)
                    update({
                      modelId: next.id,
                      parameters: normalizeParameters(next, parameters),
                    });
                  setModelOpen(false);
                }}
                onRetry={() => {}}
              />
            )}
          </Menu>
          {model && cap && (
            <Menu
              open={paramsOpen}
              onClose={() => setParamsOpen(false)}
              portal
              side="top"
              listClassName={css.mediaParameterMenu}
              anchor={
                <Button
                  className={css.mediaParameterTrigger}
                  aria-label={p.t("parameters")}
                  onClick={() => {
                    setParamsOpen(!paramsOpen);
                    setModelOpen(false);
                    setCountOpen(false);
                  }}
                >
                  {node.data.kind === "video" && (
                    <span>
                      {p.t(
                        parameters.mode === "frames"
                          ? "modeFrames"
                          : "modeReference",
                      )}
                    </span>
                  )}
                  <AspectIcon ratio={parameters.ratio} size={18} />
                  {parameters.ratio === "adaptive"
                    ? p.t("adaptive")
                    : parameters.ratio}{" "}
                  · {parameters.resolution}
                  {node.data.kind === "video"
                    ? ` · ${parameters.duration}s`
                    : ""}
                  {cap.audio &&
                    (parameters.audio ? (
                      <SpeakerHigh size={17} />
                    ) : (
                      <SpeakerSlash size={17} />
                    ))}
                </Button>
              }
            >
              <MediaParameterPanel
                p={p}
                cap={cap}
                value={parameters}
                hasFrames={refs.some((id) =>
                  project.nodes.some(
                    (n) => n.id === id && n.data.kind === "image",
                  ),
                )}
                onChange={(next) => update({ parameters: next })}
              />
            </Menu>
          )}
        </div>
        <div className={css.generationActions}>
          {model?.mode === "plan" && (
            <small className={css.costEstimate}>{p.t("planUsage")}</small>
          )}
          <Menu
            open={countOpen}
            onClose={() => setCountOpen(false)}
            portal
            side="top"
            align="end"
            listClassName={css.generationCountMenu}
            selection="fill"
            selectedId={String(config.count)}
            items={[4, 3, 2, 1].map((n) => ({ id: String(n), label: `${n}×` }))}
            onSelect={(id) => {
              update({ count: Number(id) as 1 | 2 | 3 | 4 });
              setCountOpen(false);
            }}
            anchor={
              <Button
                className={css.generationCountTrigger}
                aria-label={p.t("generationCount")}
                aria-haspopup="menu"
                aria-expanded={countOpen}
                data-active={countOpen}
                onClick={() => {
                  setModelOpen(false);
                  setParamsOpen(false);
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
            label={p.t("mediaGeneration")}
            stopLabel={p.t("stop")}
            disabled={
              !model ||
              !config.prompt.some(
                (part) => part.type === "text" && part.text.trim(),
              )
            }
            onSubmit={() => void submit()}
            onStop={() =>
              jobs
                .filter((job) => job.nodeId === node.id && jobActive(job))
                .forEach((job) => onJobAction(job, "cancel"))
            }
          />
        </div>
      </footer>
    </section>
  );
}

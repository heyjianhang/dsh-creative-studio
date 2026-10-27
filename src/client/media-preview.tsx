import { mediaUsageItems } from "./media-usage.ts";
import { useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Button,
  Tooltip,
  useModalLayer,
  writeClipboard,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { CreativeNode, MediaJob } from "../shared/contracts.ts";
import type { CanvasProps } from "./props.ts";
import { MediaView, type MediaInfo } from "./media.tsx";
import { downloadMedia } from "./media-source.ts";
import { Icon, type IconName } from "./icons.tsx";
import css from "./studio.module.css";

export function MediaPreview({
  p,
  projectId,
  data,
  start,
  onClose,
  onAdd,
  onSave,
  muted,
  onMutedChange,
}: {
  p: CanvasProps;
  projectId: string;
  data: CreativeNode["data"];
  start?: number;
  onClose(): void;
  onAdd?(): void;
  onSave?(): void;
  muted?: boolean;
  onMutedChange?(muted: boolean): void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<MediaInfo>();
  const [generation, setGeneration] = useState<MediaJob>();
  useEffect(() => {
    if (!data.generationResult || !data.media) return;
    const controller = new AbortController();
    void p
      .request("mediaJobs", { projectId }, controller.signal)
      .then((rows) =>
        setGeneration(rows.find((job) => job.result?.id === data.media?.id)),
      )
      .catch(() => {});
    return () => controller.abort();
  }, [projectId, data.media?.id, p.request]);
  useModalLayer(dialog, true, onClose);
  const file = data.media ?? data.asset;
  const actions: {
    label: string;
    icon: IconName;
    run(): void;
    disabled?: boolean;
  }[] = [];
  if (data.text.trim())
    actions.push({
      label: p.t("copyDescription"),
      icon: "copy",
      run: () => {
        void writeClipboard(data.text)
          .then((ok) => p.notify(p.t(ok ? "copied" : "copyFailed")))
          .catch(() => p.notify(p.t("copyFailed")));
      },
    });
  if (onAdd) actions.push({ label: p.t("addAsset"), icon: "plus", run: onAdd });
  actions.push({
    label: p.t("downloadOriginal"),
    icon: "download",
    disabled: !info,
    run: () => {
      if (!info) return;
      void downloadMedia(p.request, projectId, data).catch((error) =>
        p.notify(String(error.message ?? error)),
      );
    },
  });
  if (onSave)
    actions.push({ label: p.t("saveSelection"), icon: "folder", run: onSave });
  const duration = info?.duration;
  const size = file?.size;
  return createPortal(
    <div
      ref={dialog}
      className={css.mediaPreview}
      role="dialog"
      aria-modal="true"
      aria-label={data.label || p.t("previewTitle")}
      tabIndex={-1}
      data-studio-preview
      data-shortcut-modal="creative-preview"
      onKeyDown={(e) => {
        if (
          e.key !== " " ||
          e.nativeEvent.isComposing ||
          e.repeat ||
          e.metaKey ||
          e.ctrlKey ||
          e.altKey ||
          (e.target as Element).closest("button,input,video")
        )
          return;
        const video = dialog.current?.querySelector("video");
        if (!video) return;
        e.preventDefault();
        if (video.paused) void video.play().catch(() => {});
        else video.pause();
      }}
    >
      <header className={css.previewHeader}>
        <Tooltip label={p.t("back")} side="right">
          <Button
            className={css.previewBack}
            aria-label={p.t("back")}
            onClick={onClose}
          >
            <Icon name="back" size={23} />
          </Button>
        </Tooltip>
        <span>{data.label}</span>
      </header>
      <div className={css.previewLayout}>
        <main className={css.previewMain}>
          <div
            className={css.previewStage}
            tabIndex={0}
            data-modal-autofocus
            onClick={(e) => {
              if (!(e.target as Element).closest("video"))
                e.currentTarget.focus({ preventScroll: true });
            }}
          >
            <MediaView
              request={p.request}
              projectId={projectId}
              data={data}
              autoPlay
              start={start}
              muted={muted}
              onMutedChange={onMutedChange}
              onReady={setInfo}
            />
          </div>
          {(data.text.trim() || generation?.snapshot.prompt) && (
            <section className={css.previewDescription}>
              <h3>{p.t("assetDescription")}</h3>
              <p>{generation?.snapshot.prompt || data.text}</p>
            </section>
          )}
        </main>
        <aside className={css.previewDetails} aria-label={p.t("fileInfo")}>
          <dl>
            {!!info?.width && !!info.height && (
              <div>
                <dt>{p.t("resolution")}</dt>
                <dd>
                  {info.width} × {info.height}
                </dd>
              </div>
            )}
            {file?.mime && (
              <div>
                <dt>{p.t("format")}</dt>
                <dd>{file.mime.split("/")[1]?.toUpperCase()}</dd>
              </div>
            )}
            {size !== undefined && (
              <div>
                <dt>{p.t("fileSize")}</dt>
                <dd>
                  {size >= 1024 ** 2
                    ? `${(size / 1024 ** 2).toFixed(1)} MB`
                    : `${Math.max(1, Math.round(size / 1024))} KB`}
                </dd>
              </div>
            )}
            {duration !== undefined && Number.isFinite(duration) && (
              <div>
                <dt>{p.t("duration")}</dt>
                <dd>
                  {Math.floor(duration / 60)}:
                  {String(Math.floor(duration % 60)).padStart(2, "0")}
                </dd>
              </div>
            )}
            {generation && (
              <>
                <div>
                  <dt>{p.t("created")}</dt>
                  <dd>{new Date(generation.createdAt).toLocaleDateString()}</dd>
                </div>
                <div>
                  <dt>{p.t("model")}</dt>
                  <dd>{generation.snapshot.model.name}</dd>
                </div>
                {generation.estimate && (
                  <div>
                    <dt>{p.t("estimatedCost")}</dt>
                    <dd>
                      {generation.estimate.currency}{" "}
                      {generation.estimate.amount.toFixed(3)}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>{p.t("billing")}</dt>
                  <dd>
                    {p.t(
                      generation.snapshot.billingMode === "plan"
                        ? "planUsage"
                        : "providerBill",
                    )}
                  </dd>
                </div>
                {!!Object.keys(generation.usage ?? {}).length && (
                  <div>
                    <dt>{p.t("usage")}</dt>
                    <dd>
                      {mediaUsageItems(generation.usage!, p.t).map(
                        ({ key, label, value }) => (
                          <small key={key} style={{ display: "block" }}>
                            {label}: {value}
                          </small>
                        ),
                      )}
                    </dd>
                  </div>
                )}
              </>
            )}
          </dl>
        </aside>
      </div>
      <nav className={css.previewActions} aria-label={p.t("more")}>
        {actions.map((action) => (
          <Tooltip key={action.label} label={action.label} side="top">
            <Button
              aria-label={action.label}
              disabled={action.disabled}
              onClick={action.run}
            >
              <Icon name={action.icon} size={22} />
            </Button>
          </Tooltip>
        ))}
      </nav>
    </div>,
    document.body,
  );
}

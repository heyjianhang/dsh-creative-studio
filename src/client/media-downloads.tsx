import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { CanvasProps } from "./props.ts";
import { mediaSession } from "./media-source.ts";
import {
  safeDownloadName,
  savePickedFile,
  type SaveFilePicker,
} from "./media-download.ts";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";

export function MediaDownloadDialogs({ p }: { p: CanvasProps }) {
  const downloads = mediaSession(p.request).downloads;
  const task = useSyncExternalStore(downloads.subscribe, downloads.getSnapshot);
  const [name, setName] = useState("");
  useEffect(() => {
    setName(task?.name ?? "");
  }, [task?.id]);
  useEffect(() => () => downloads.clear(), [downloads]);
  if (!task) return null;
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  const busy = task.status === "preparing" || task.status === "saving";
  const save = async (browser = false) => {
    const outcome = await downloads.save(
      task.id,
      safeDownloadName(name),
      async (file, filename) => {
        if (picker && !browser)
          return savePickedFile(picker.bind(window), file, filename);
        const link = document.createElement("a");
        link.href = file.src;
        link.download = filename;
        link.click();
        return "browser";
      },
    );
    if (outcome)
      p.notify(
        p.t(outcome === "saved" ? "fileSaved" : "browserDownloadStarted"),
      );
  };
  return (
    <Modal
      open
      title={p.t("saveFile")}
      closeLabel={p.t("close")}
      className={css.downloadDialog}
      onClose={() => downloads.cancel(task.id)}
      footer={
        <>
          <Button
            disabled={task.status === "saving"}
            onClick={() => downloads.cancel(task.id)}
          >
            {p.t("cancel")}
          </Button>
          {picker && task.error && (
            <Button disabled={busy} onClick={() => void save(true)}>
              {p.t("browserSave")}
            </Button>
          )}
          <Button
            variant="primary"
            disabled={busy || task.status === "error" || !name.trim()}
            onClick={() => void save()}
          >
            {p.t(task.status === "saving" ? "saving" : "save")}
          </Button>
        </>
      }
    >
      <div className={css.downloadFile}>
        <Icon name="download" size={24} />
        <span>{task.name}</span>
      </div>
      {busy ? (
        <div className={css.downloadPreparing} role="status">
          <span className={css.sendSpinner} />
          {p.t(task.status === "preparing" ? "preparingFile" : "saving")}
        </div>
      ) : (
        task.status === "ready" && (
          <label className={css.downloadName}>
            {p.t("saveFileName")}
            <Input
              data-modal-autofocus
              value={name}
              maxLength={240}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing &&
                  name.trim()
                )
                  void save();
              }}
            />
          </label>
        )
      )}
      {!picker && task.status === "ready" && (
        <p className={css.downloadHint}>{p.t("browserSaveHint")}</p>
      )}
      {task.error && (
        <p role="alert" className={css.downloadError}>
          {task.error}
        </p>
      )}
    </Modal>
  );
}

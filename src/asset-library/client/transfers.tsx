import { useState, useRef, useEffect } from "react";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SharedProps } from "./props.ts";
import { ChoiceMenu } from "./choice-menu.tsx";
import css from "./library.module.css";

export function TransferDialog(
  p: SharedProps & {
    kind: "export" | "import";
    libraryId?: string;
    storageMode?: "local" | "s3";
    onClose(): void;
  },
) {
  const settings = p.useCatalog((s) => s.data?.settings);
  const [path, setPath] = useState(""),
    [file, setFile] = useState<File>(),
    [mode, setMode] = useState<"local" | "s3">(
      p.storageMode ?? settings?.storageMode ?? "local",
    );
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [error, setError] = useState("");
  const abort = useRef<AbortController>();
  useEffect(() => () => abort.current?.abort(), []);
  const submit = async () => {
    setBusy(true);
    setError("");
    setProgress(0);
    const control = new AbortController();
    abort.current = control;
    let archiveId: string | undefined,
      submitted = false;
    try {
      await p.flushEdits();
      if (p.kind === "import") {
        if (!file) throw new Error(p.t("chooseZip"));
        const upload = await p.request(
          "archiveUpload",
          { action: "begin", size: file.size },
          control.signal,
        );
        archiveId = upload.id;
        let offset = 0;
        while (offset < file.size) {
          control.signal.throwIfAborted();
          const bytes = new Uint8Array(
            await file.slice(offset, offset + 1024 ** 2).arrayBuffer(),
          );
          let binary = "";
          for (let i = 0; i < bytes.length; i += 16384)
            binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
          const chunk = await p.request(
            "archiveUpload",
            { action: "chunk", id: archiveId, offset, data: btoa(binary) },
            control.signal,
          );
          offset = chunk.offset;
          setProgress(Math.round((offset / file.size) * 100));
        }
      }
      control.signal.throwIfAborted();
      await p.request("startTransfer", {
        kind: p.kind,
        libraryId: p.libraryId,
        archiveId,
        path,
        storageMode: mode,
      });
      submitted = true;
      await p.refresh();
      p.onClose();
    } catch (e) {
      if (!control.signal.aborted) setError((e as Error).message);
    } finally {
      if (archiveId && !submitted)
        await p
          .request("archiveUpload", { action: "cancel", id: archiveId })
          .catch(() => {});
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={p.t(p.kind === "export" ? "exportZip" : "importZip")}
      closeLabel={p.t("close")}
      onClose={() => {
        if (!busy) p.onClose();
      }}
      backdropBlur={false}
      className={css.transferModal}
      contentClassName={css.modalContent}
      footer={
        <>
          <Button onClick={() => (busy ? abort.current?.abort() : p.onClose())}>
            {p.t("cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !path.trim() || (p.kind === "import" && !file)}
            onClick={() => void submit()}
          >
            {p.t(busy ? "busy" : "startTransfer")}
          </Button>
        </>
      }
    >
      <div className={css.form}>
        <p className={css.muted}>
          {p.t(p.kind === "export" ? "exportHelp" : "importZipHelp")}
        </p>
        {p.kind === "import" && (
          <label>
            {p.t("chooseZip")}
            <Input
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0])}
            />
          </label>
        )}
        <label>
          {p.t(p.kind === "export" ? "exportFolder" : "newLibraryFolder")}
          <div className={css.folderField}>
            <Input
              disabled={busy}
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void p
                  .pickDirectory()
                  .then((dir) => {
                    if (dir)
                      setPath(
                        p.kind === "import"
                          ? dir.replace(/[/\\]$/, "") +
                              "/" +
                              (file?.name.replace(/\.zip$/i, "") ??
                                "Imported Library")
                          : dir,
                      );
                  })
                  .catch((e) => setError(e.message))
              }
            >
              {p.t("chooseFolder")}
            </Button>
          </div>
        </label>
        {p.kind === "import" && (
          <label>
            {p.t("importStorage")}
            <ChoiceMenu<"local" | "s3">
              label={p.t("importStorage")}
              value={mode}
              disabled={busy}
              options={[
                { id: "local", label: p.t("localStorage") },
                { id: "s3", label: p.t("s3Storage") },
              ]}
              onChange={setMode}
            />
          </label>
        )}
        {busy && (
          <>
            <p role="status">
              {p.t("uploadingZip")} {progress}%
            </p>
            <progress className={css.progress} max={100} value={progress} />
          </>
        )}
        {error && (
          <div role="alert" className={css.error}>
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
export function TransferList(p: SharedProps) {
  const transfers = p.useCatalog((s) => s.data?.transfers ?? []),
    [error, setError] = useState("");
  const jobs = transfers.filter(
    (job) => job.status !== "completed" && job.status !== "cancelled",
  );
  if (!jobs.length && !error) return null;
  return (
    <div className={css.taskList}>
      {error && (
        <p role="alert" className={css.error}>
          {error}
        </p>
      )}
      {jobs.map((job) => (
        <div className={css.task} key={job.id}>
          <div className={css.taskHeading}>
            <div>
              <strong>
                {p.t(job.kind === "export" ? "exportZip" : "importZip")} ·{" "}
                {job.name}
              </strong>
              <p className={css.meta}>
                {p.t(job.status)} · {job.progress}% · {job.detail}
              </p>
            </div>
            <div className={css.row}>
              {["failed", "paused"].includes(job.status) && (
                <Button
                  size="sm"
                  onClick={() =>
                    void p
                      .request("transfer", { id: job.id, action: "retry" })
                      .then(p.refresh)
                      .catch((e) => setError(e.message))
                  }
                >
                  {p.t("retry")}
                </Button>
              )}
              {["queued", "running", "paused"].includes(job.status) && (
                <Button
                  size="sm"
                  onClick={() =>
                    void p
                      .request("transfer", { id: job.id, action: "cancel" })
                      .then(p.refresh)
                      .catch((e) => setError(e.message))
                  }
                >
                  {p.t("cancel")}
                </Button>
              )}
            </div>
          </div>
          <progress className={css.progress} max={100} value={job.progress} />
          {job.error && <p className={css.taskError}>{job.error}</p>}
        </div>
      ))}
    </div>
  );
}

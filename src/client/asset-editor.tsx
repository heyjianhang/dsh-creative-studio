import { useEffect, useRef, useState } from "react";
import {
  Button,
  Input,
  Modal,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import {
  type CreativeAsset,
  type CreativeAssetDraft,
  type Resource,
} from "../shared/contracts.ts";
import type { CanvasProps } from "./props.ts";
import { Icon } from "./icons.tsx";
import { upload } from "./media.tsx";
import {
  AssetThumbnail,
  resourceKey,
  resourceName,
  uniqueResources,
  type AssetDraft,
} from "./asset-shared.tsx";
import { FolderPicker } from "./creative-folders.tsx";
import css from "./studio.module.css";

export function AssetEditor({
  p,
  draft,
  onBack,
  onLibrary,
  onPreview,
  onAdd,
  onChanged,
}: {
  p: CanvasProps;
  draft: AssetDraft;
  onBack(): void;
  onLibrary(draft: AssetDraft): void;
  onPreview(r: Resource): void;
  onAdd(refs: Resource[], item?: CreativeAsset): void;
  onChanged(): void;
}) {
  const [value, setValue] = useState(draft.value);
  const [status, setStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [pending, setPending] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [folderLabel, setFolderLabel] = useState("");
  const saved = useRef(draft.record),
    latest = useRef(value);
  const persisted = useRef(
    JSON.stringify(
      draft.record
        ? {
            name: draft.record.name,
            category: draft.record.category,
            description: draft.record.description,
            references: draft.record.references,
            folderId: draft.record.folderId,
            ownerProjectId: draft.record.ownerProjectId,
          }
        : null,
    ),
  );
  const tail = useRef(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const alive = useRef(true),
    locked = useRef(false),
    removing = useRef(false);
  const uploadAbort = useRef<AbortController>();
  const input = useRef<HTMLInputElement>(null);
  const projectId = p.useStudio((s) => s.current!.id);
  latest.current = value;
  const valid = !!value.name.trim() && value.references.length > 0;
  useEffect(() => {
    const abort = new AbortController();
    void p
      .request(
        "creativeFolders",
        { projectId: value.ownerProjectId },
        abort.signal,
      )
      .then((folders) => {
        if (!abort.signal.aborted)
          setFolderLabel(
            folders.find((f) => f.id === value.folderId)?.name ??
              p.t("rootFolder"),
          );
      })
      .catch(() => {});
    return () => abort.abort();
  }, [value.folderId, value.ownerProjectId]);

  const flush = (snapshot = latest.current) => {
    clearTimeout(timer.current);
    const work = tail.current.then(async () => {
      if (
        !saved.current ||
        removing.current ||
        JSON.stringify(snapshot) === persisted.current
      )
        return;
      if (!snapshot.name.trim() || !snapshot.references.length)
        throw new Error(p.t("assetRequired"));
      if (alive.current) {
        setStatus("saving");
        setError("");
      }
      const result = await p.request("updateCreativeAsset", {
        ...snapshot,
        id: saved.current.id,
        revision: saved.current.revision,
      });
      saved.current = result;
      persisted.current = JSON.stringify(snapshot);
      onChanged();
      if (alive.current)
        setStatus(
          JSON.stringify(latest.current) === persisted.current
            ? "saved"
            : "unsaved",
        );
    });
    tail.current = work.catch(() => {});
    return work;
  };
  const failure = (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (alive.current) {
      setError(message);
      setStatus("unsaved");
    } else p.notify(message);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      uploadAbort.current?.abort();
      if (saved.current && !removing.current)
        void flush(latest.current).catch(failure);
    };
  }, []);
  useEffect(() => {
    if (!saved.current || persisted.current === JSON.stringify(value)) return;
    setStatus("unsaved");
    if (valid)
      timer.current = setTimeout(() => {
        void flush(value).catch(failure);
      }, 650);
    return () => clearTimeout(timer.current);
  }, [value]);

  function update(patch: Partial<CreativeAssetDraft>) {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setValue(next);
  }
  async function run(action: () => Promise<void>) {
    if (locked.current || uploadAbort.current) return;
    locked.current = true;
    setPending(true);
    setError("");
    try {
      await action();
    } catch (e) {
      failure(e);
    } finally {
      locked.current = false;
      if (alive.current) setPending(false);
    }
  }
  const back = () => {
    void run(async () => {
      await flush();
      onBack();
    });
  };
  async function files(list: File[]) {
    if (!list.length || uploadAbort.current || locked.current) return;
    if (latest.current.references.length + list.length > 24) {
      setError(p.t("referenceLimit"));
      return;
    }
    const abort = new AbortController();
    uploadAbort.current = abort;
    setError("");
    try {
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        setUploading(`${p.t("uploading")} ${i + 1}/${list.length} · 0%`);
        const media = await upload(
          p.request,
          projectId,
          file,
          (percent) =>
            setUploading(
              `${p.t("uploading")} ${i + 1}/${list.length} · ${percent}%`,
            ),
          abort.signal,
        );
        abort.signal.throwIfAborted();
        const reference: Resource = {
          kind: media.mime.startsWith("video/") ? "video" : "image",
          media,
        };
        update({
          references: uniqueResources([
            ...latest.current.references,
            reference,
          ]),
          ...(!latest.current.name.trim()
            ? { name: file.name.replace(/\.[^.]+$/, "").slice(0, 120) }
            : {}),
        });
      }
    } catch (e) {
      if (!abort.signal.aborted) failure(e);
    } finally {
      uploadAbort.current = undefined;
      if (alive.current) setUploading("");
    }
  }

  return (
    <div
      className={css.assetEditor}
      onKeyDown={(e) => {
        if (
          e.key === "Escape" &&
          !deleting &&
          !choosingFolder &&
          !e.defaultPrevented &&
          !(e.target as Element).closest(
            '[role="menu"],[role="dialog"]:not([data-studio-surface])',
          )
        ) {
          e.preventDefault();
          e.stopPropagation();
          back();
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void files(Array.from(e.dataTransfer.files));
      }}
    >
      <header className={css.libraryHeader}>
        <Button
          className={css.tool}
          disabled={pending || !!uploading}
          aria-label={p.t("back")}
          onClick={back}
        >
          <Icon name="back" />
        </Button>
        <strong>
          {p.t(draft.record ? "editCreativeAsset" : "newCreativeAsset")}
        </strong>
        {draft.record && (
          <span className={css.librarySaveState} aria-live="polite">
            {p.t(status)}
          </span>
        )}
      </header>
      <div className={css.assetEditorBody}>
        <label className={css.libraryField}>
          {p.t("assetName")}
          <Input
            autoFocus
            className={css.libraryInput}
            value={value.name}
            maxLength={120}
            disabled={pending}
            placeholder={p.t("assetNameHint")}
            onChange={(e) => update({ name: e.target.value })}
          />
        </label>
        <div className={css.libraryField}>
          <span>{p.t("folderLocation")}</span>
          <Button
            className={css.assetFolderLocation}
            disabled={pending || !!uploading}
            onClick={() => setChoosingFolder(true)}
          >
            <Icon name="folder" size={18} />
            <span>
              {p.t(value.ownerProjectId ? "currentProject" : "personalAssets")}{" "}
              / {folderLabel}
            </span>
            <Icon name="down" size={15} />
          </Button>
        </div>
        <label className={css.libraryField}>
          {p.t("assetDescription")}
          <textarea
            className={css.libraryDescription}
            value={value.description}
            maxLength={5000}
            disabled={pending}
            placeholder={p.t("assetDescriptionHint")}
            onChange={(e) => update({ description: e.target.value })}
          />
        </label>
        <div className={css.librarySectionHeading}>
          <strong>{p.t("references")}</strong>
          <span>{value.references.length}/24</span>
        </div>
        <div className={css.referenceActions}>
          <Button
            variant="outline"
            disabled={pending || !!uploading || value.references.length >= 24}
            onClick={() => input.current?.click()}
          >
            <Icon name="upload" size={16} />
            {p.t("upload")}
          </Button>
          <Button
            variant="outline"
            disabled={pending || !!uploading || value.references.length >= 24}
            onClick={() =>
              void run(async () => {
                await flush();
                onLibrary({ value: latest.current, record: saved.current });
              })
            }
          >
            <Icon name="folder" size={16} />
            {p.t("fromAssetLibrary")}
          </Button>
        </div>
        <input
          hidden
          ref={input}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.mov"
          onChange={(e) => {
            const list = Array.from(e.target.files ?? []);
            e.target.value = "";
            void files(list);
          }}
        />
        {uploading && (
          <div className={css.libraryNotice} role="status">
            <span>{uploading}</span>
            <Button onClick={() => uploadAbort.current?.abort()}>
              {p.t("stop")}
            </Button>
          </div>
        )}
        {value.references.length ? (
          <div className={css.referenceGrid}>
            {value.references.map((r) => (
              <div className={css.referenceItem} key={resourceKey(r)}>
                <button
                  className={css.referencePreview}
                  aria-label={`${p.t("previewAsset")} · ${resourceName(r)}`}
                  onClick={() => onPreview(r)}
                >
                  <AssetThumbnail p={p} resource={r} />
                </button>
                <span title={resourceName(r)}>{resourceName(r)}</span>
                <Tooltip label={p.t("removeReference")}>
                  <Button
                    className={css.referenceRemove}
                    aria-label={`${p.t("removeReference")} · ${resourceName(r)}`}
                    disabled={pending}
                    onClick={() =>
                      update({
                        references: value.references.filter(
                          (x) => resourceKey(x) !== resourceKey(r),
                        ),
                      })
                    }
                  >
                    <Icon name="close" size={15} />
                  </Button>
                </Tooltip>
              </div>
            ))}
          </div>
        ) : (
          <div className={css.referenceEmpty}>
            <Icon name="image" size={26} />
            <span>{p.t("referenceHint")}</span>
          </div>
        )}
        {error && (
          <div className={css.libraryNotice} role="alert">
            <span>{error}</span>
            {draft.record && (
              <>
                <Button
                  disabled={pending || !valid}
                  onClick={() => void run(() => flush())}
                >
                  {p.t("retry")}
                </Button>
                <Button
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      clearTimeout(timer.current);
                      await tail.current;
                      const record = await p.request("getCreativeAsset", {
                        id: saved.current!.id,
                      });
                      const next = {
                        name: record.name,
                        category: record.category,
                        description: record.description,
                        references: record.references,
                        folderId: record.folderId,
                        ownerProjectId: record.ownerProjectId,
                      };
                      saved.current = record;
                      persisted.current = JSON.stringify(next);
                      update(next);
                      setStatus("saved");
                    })
                  }
                >
                  {p.t("reloadAsset")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      <footer className={css.libraryFooter}>
        {draft.record ? (
          <>
            <Tooltip label={p.t("deleteCreativeAsset")}>
              <Button
                className={css.tool}
                disabled={pending || !!uploading}
                aria-label={p.t("deleteCreativeAsset")}
                onClick={() => setDeleting(true)}
              >
                <Icon name="trash" size={18} />
              </Button>
            </Tooltip>
            <Button
              variant="primary"
              disabled={pending || !!uploading || !valid}
              onClick={() =>
                void run(async () => {
                  await flush();
                  onAdd(latest.current.references, saved.current);
                })
              }
            >
              <Icon name="plus" size={17} />
              {p.t("addAsset")}
            </Button>
          </>
        ) : (
          <>
            <Button disabled={pending || !!uploading} onClick={back}>
              {p.t("cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={pending || !!uploading || !valid}
              onClick={() =>
                void run(async () => {
                  const result = await p.request(
                    "createCreativeAsset",
                    latest.current,
                  );
                  saved.current = result;
                  persisted.current = JSON.stringify(latest.current);
                  onChanged();
                  p.notify(p.t("assetCreated"));
                  onBack();
                })
              }
            >
              {p.t(pending ? "saving" : "saveCreativeAsset")}
            </Button>
          </>
        )}
      </footer>
      {choosingFolder && (
        <FolderPicker
          p={p}
          initial={{
            folderId: value.folderId ?? null,
            ownerProjectId: value.ownerProjectId,
          }}
          onClose={() => setChoosingFolder(false)}
          onConfirm={(destination) => {
            update(destination);
            setChoosingFolder(false);
          }}
        />
      )}
      <Modal
        open={deleting}
        title={p.t("deleteCreativeAsset")}
        onClose={() => !pending && setDeleting(false)}
        closeLabel={p.t("close")}
        footer={
          <>
            <Button disabled={pending} onClick={() => setDeleting(false)}>
              {p.t("cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  // Delete uses the latest revision, including edits already queued for saving.
                  await tail.current;
                  clearTimeout(timer.current);
                  const record = saved.current!;
                  await p.request("removeCreativeAsset", {
                    id: record.id,
                    revision: record.revision,
                  });
                  removing.current = true;
                  onChanged();
                  p.notify(p.t("assetDeleted"));
                  onBack();
                })
              }
            >
              {p.t("confirmDeleteAsset")}
            </Button>
          </>
        }
      >
        <p>{p.t("deleteCreativeAssetHint")}</p>
      </Modal>
    </div>
  );
}

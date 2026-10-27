import { useRef, useState } from "react";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { CreativeAsset } from "../shared/contracts.ts";
import type { CanvasProps } from "./props.ts";
import { FolderPicker, type Destination } from "./creative-folders.tsx";
import css from "./studio.module.css";

export type AssetAction = {
  type: "rename" | "move" | "copy" | "delete";
  item: CreativeAsset;
};
export function CreativeAssetAction({
  p,
  action,
  onClose,
  onChanged,
}: {
  p: CanvasProps;
  action: AssetAction;
  onClose(): void;
  onChanged(item?: CreativeAsset): void;
}) {
  const { item, type } = action;
  const [name, setName] = useState(
    type === "copy"
      ? `${item.name.slice(0, 110)} ${p.t("assetCopySuffix")}`
      : item.name,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const locked = useRef(false);
  const title = p.t(
    type === "rename"
      ? "renameAsset"
      : type === "copy"
        ? "copyAsset"
        : type === "move"
          ? "moveAsset"
          : "deleteCreativeAsset",
  );
  async function save(destination?: Destination) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      if (type === "delete") {
        await p.request("removeCreativeAsset", {
          id: item.id,
          revision: item.revision,
        });
        onChanged();
        p.notify(p.t("assetDeleted"));
      } else {
        const value = {
          name: name.trim(),
          description: item.description,
          category: item.category,
          references: item.references,
          folderId: item.folderId ?? null,
          ownerProjectId: item.ownerProjectId,
          ...destination,
        };
        const result =
          type === "copy"
            ? await p.request("createCreativeAsset", value)
            : await p.request("updateCreativeAsset", {
                ...value,
                id: item.id,
                revision: item.revision,
              });
        onChanged(result);
        p.notify(
          p.t(
            type === "copy"
              ? "assetCopied"
              : type === "move"
                ? "assetMoved"
                : "saved",
          ),
        );
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  if (type === "move")
    return (
      <FolderPicker
        p={p}
        initial={{
          folderId: item.folderId ?? null,
          ownerProjectId: item.ownerProjectId,
        }}
        busy={busy}
        locked={busy}
        error={error}
        onClose={onClose}
        onConfirm={(destination) => void save(destination)}
      />
    );
  return (
    <Modal
      open
      title={title}
      className={css.folderNameDialog}
      onClose={() => !busy && onClose()}
      closeLabel={p.t("close")}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {p.t("cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || (type !== "delete" && !name.trim())}
            onClick={() => void save()}
          >
            {p.t(
              busy
                ? "saving"
                : type === "delete"
                  ? "confirmDeleteAsset"
                  : type === "copy"
                    ? "copyAsset"
                    : "save",
            )}
          </Button>
        </>
      }
    >
      {type === "delete" ? (
        <>
          <p>{item.name}</p>
          <p>{p.t("deleteCreativeAssetHint")}</p>
        </>
      ) : (
        <label className={css.libraryField}>
          {p.t("assetName")}
          <Input
            autoFocus
            className={css.libraryInput}
            value={name}
            maxLength={120}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.nativeEvent.isComposing &&
                name.trim()
              ) {
                e.preventDefault();
                void save();
              }
            }}
          />
        </label>
      )}
      {error && (
        <div className={css.libraryNotice} role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}

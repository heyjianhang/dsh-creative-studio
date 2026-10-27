import { useRef, useState } from "react";
import type { Resource } from "../shared/contracts.ts";
import type { CanvasProps } from "./props.ts";
import { FolderPicker, type Destination } from "./creative-folders.tsx";

export function SaveCreativeResources({
  p,
  resources,
  onClose,
}: {
  p: CanvasProps;
  resources: Resource[];
  onClose(): void;
}) {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(destination: Destination) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await p.request("addCreativeResources", { resources, ...destination });
      p.notify(p.t("saved"));
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <FolderPicker
      p={p}
      initial={{ folderId: null }}
      busy={busy}
      locked={busy}
      progress={busy ? p.t("saving") : undefined}
      error={error}
      onClose={() => {
        if (!locked.current) onClose();
      }}
      onConfirm={(destination) => void save(destination)}
    />
  );
}

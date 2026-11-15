import { useEffect, useRef, useState } from "react";
import { Button, Menu, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ComponentProps } from "react";
import type { Output, Resource } from "../shared/contracts.ts";
import type { CanvasProps } from "./props.ts";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";

type Item = NonNullable<ComponentProps<typeof Menu>["items"]>[number];
type Destination = { libraryId: string; collectionId?: string; name: string };

/** Choose a destination for canvas files and existing library assets. */
export function SaveToLibrary({
  p,
  projectId,
  resources,
  className,
  showLabel = false,
}: {
  p: CanvasProps;
  projectId: string;
  resources: Resource[];
  className?: string;
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Output<"libraryInfo">>();
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const locked = useRef(false);
  const libraryIds = new Set(resources.flatMap((r) => r.asset ? [r.asset.libraryId] : []));
  const hasFiles = resources.some((r) => !!r.media);
  const label = p.t(hasFiles ? "saveToLibrary" : "addToCollection");
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void p.request("libraryInfo", {}, abort.signal).then(
      (value) => { if (!abort.signal.aborted) setInfo(value); },
      () => { if (!abort.signal.aborted) setError(true); },
    );
    return () => abort.abort();
  }, [open, p.request]);

  const destinations = new Map<string, Destination>();
  const items: Item[] = [];
  if (resources.length > 24) {
    items.push({ id: "limit", label: p.t("referenceLimit"), disabled: true });
  } else if (libraryIds.size > 1) {
    items.push({ id: "mixed", label: p.t("collectionLibraryMismatch"), disabled: true });
  } else if (error) {
    items.push({ id: "error", label: p.t("saveLibraryFailed"), disabled: true });
  } else if (!info) {
    items.push({ id: "loading", label: p.t("opening"), disabled: true });
  } else {
    const libraries = info.libraries.filter((l) =>
      l.available && (!libraryIds.size || libraryIds.has(l.id)));
    for (const library of libraries) {
      const folders = info.folders.filter((folder) => folder.libraryId === library.id);
      if (libraries.length > 1)
        items.push({ type: "label", id: `title:${library.id}`, text: library.name });
      if (hasFiles) {
        const id = `library:${library.id}`;
        destinations.set(id, { libraryId: library.id, name: library.name });
        items.push({ id, label: p.t("saveLibraryOnly"), icon: <Icon name="plus" size={16} /> });
        if (folders.length) items.push({ type: "separator", id: `sep:${library.id}` });
      }
      for (const folder of folders) {
        const id = `collection:${library.id}:${folder.id}`;
        destinations.set(id, { libraryId: library.id, collectionId: folder.id, name: folder.name });
        items.push({ id, label: folder.name, icon: <Icon name="folder" size={16} /> });
      }
    }
    if (!items.length)
      items.push({
        id: "empty",
        label: p.t(libraries.length ? "noCollections" : "noLibraries"),
        disabled: true,
      });
  }
  async function save(destination: Destination) {
    if (locked.current) return;
    locked.current = true;
    setOpen(false);
    setSaving(true);
    const { name, ...location } = destination;
    try {
      if (hasFiles) await p.editor.flush();
      await p.request("saveLibraryResources", { projectId, resources, ...location });
      p.notify(location.collectionId
        ? `${p.t("addedToCollection")} 「${name}」`
        : p.t("savedToLibrary"));
    } catch (error) {
      p.notify(`${p.t("saveLibraryFailed")} · ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }
  return (
    <Menu
      portal
      dense
      compact
      open={open}
      onClose={() => setOpen(false)}
      listClassName={`${css.librarySelectMenu} ${css.saveLibraryMenu}`}
      anchor={
        <Tooltip label={label} side="top" portal>
          <Button
            className={className}
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-busy={saving || undefined}
            disabled={saving || !resources.length}
            onClick={() => {
              if (!open) {
                setInfo(undefined);
                setError(false);
              }
              setOpen(!open);
            }}
          >
            <Icon name="folder" size={showLabel ? 17 : 20} />
            {showLabel && label}
          </Button>
        </Tooltip>
      }
      items={items}
      onSelect={(id) => {
        const destination = destinations.get(id);
        if (destination) void save(destination);
      }}
    />
  );
}

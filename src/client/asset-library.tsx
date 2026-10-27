import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  Button,
  Input,
  Menu,
  Modal,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  CreativeAsset,
  CreativeFolder,
  Resource,
} from "../shared/contracts.ts";
import type { CanvasProps } from "./props.ts";
import { Icon } from "./icons.tsx";
import { upload } from "./media.tsx";
import { MediaPreview } from "./media-preview.tsx";
import { AssetEditor } from "./asset-editor.tsx";
import { AssetHoverPreview, useAssetHover } from "./asset-hover.tsx";
import {
  CreativeAssetAction,
  type AssetAction,
} from "./creative-asset-action.tsx";
import { downloadMedia } from "./media-source.ts";
import {
  AssetThumbnail,
  LibrarySelect,
  resourceName,
  uniqueResources,
  type AssetDraft,
} from "./asset-shared.tsx";
import { FolderPicker, type Destination } from "./creative-folders.tsx";
import { ResourceBrowser, ResourcePicker } from "./resource-picker.tsx";
import css from "./studio.module.css";

type Incoming = {
  resources: Resource[];
  files?: File[];
  destination: Destination;
};
type FolderAction = {
  type: "create" | "rename" | "delete";
  folder?: CreativeFolder;
  parentId?: string | null;
};
export function AssetLibrary({
  p,
  onClose,
  onAdd,
}: {
  p: CanvasProps;
  onClose(): void;
  onAdd(refs: Resource[], creative?: CreativeAsset): void;
}) {
  const projectId = p.useStudio((s) => s.current!.id);
  const tabsId = useId();
  const [tab, setTab] = useState<"creative" | "library">("creative");
  const [libraryVisited, setLibraryVisited] = useState(false);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [project, setProject] = useState(false),
    [query, setQuery] = useState(""),
    [ai, setAi] = useState(true),
    [composing, setComposing] = useState(false);
  const [folders, setFolders] = useState<CreativeFolder[]>([]),
    [items, setItems] = useState<CreativeAsset[]>([]);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState<
    "aiSearchFallback" | "aiSearchPartial" | ""
  >("");
  const [expanded, setExpanded] = useState(new Set<string>()),
    [active, setActive] = useState<string>();
  const [addMenu, setAddMenu] = useState(false),
    [folderMenu, setFolderMenu] = useState<string>();
  const [draft, setDraft] = useState<AssetDraft>();
  const [picker, setPicker] = useState<"add" | "references">();
  const [incoming, setIncoming] = useState<Incoming>();
  const [committing, setCommitting] = useState(false);
  const [working, setWorking] = useState(false),
    [progress, setProgress] = useState(""),
    [importError, setImportError] = useState("");
  const [folderAction, setFolderAction] = useState<FolderAction>(),
    [folderName, setFolderName] = useState(""),
    [folderError, setFolderError] = useState("");
  const [savingFolder, setSavingFolder] = useState(false);
  const [preview, setPreview] = useState<Resource>();
  const [assetMenu, setAssetMenu] = useState<string>();
  const [assetAction, setAssetAction] = useState<AssetAction>();
  const input = useRef<HTMLInputElement>(null),
    search = useRef<HTMLInputElement>(null),
    tree = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: NaN, y: NaN }),
    transfer = useRef<AbortController>(),
    completedUploads = useRef<Resource[]>([]);
  const reveal = useRef<string>();
  const ownerProjectId = project ? projectId : undefined;
  const destination = {
    folderId: folders.some((f) => f.id === active) ? active! : null,
    ownerProjectId,
  };
  const refreshList = () => setRefresh((n) => n + 1);
  const overlay =
    !!picker || !!incoming || !!folderAction || !!preview || !!assetAction;
  const assetHover = useAssetHover(
    tab === "creative" &&
      !overlay &&
      !draft &&
      !assetMenu &&
      !folderMenu &&
      !addMenu,
  );
  useEffect(() => assetHover.dismiss(), [query, project, refresh]);

  useEffect(() => () => transfer.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    setFolders([]);
    void p
      .request("creativeFolders", { projectId: ownerProjectId }, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) {
          setFolders(value);
          if (reveal.current && value.some((f) => f.id === reveal.current)) {
            const ancestors: string[] = [];
            let id: string | null = reveal.current;
            while (id) {
              ancestors.push(id);
              id = value.find((f) => f.id === id)?.parentId ?? null;
            }
            setExpanded((old) => new Set([...old, ...ancestors]));
            setActive(reveal.current);
            reveal.current = undefined;
          }
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e.message ?? e));
      });
    return () => abort.abort();
  }, [ownerProjectId, refresh]);
  useEffect(() => {
    if (tab !== "creative" || composing || draft) return;
    const abort = new AbortController();
    setBusy(true);
    setError("");
    const timer = setTimeout(
      async () => {
        try {
          let offset = 0,
            all: CreativeAsset[] = [],
            total = 1;
          let message: typeof notice = "";
          while (offset < total) {
            const result = await p.request(
              "creativeAssets",
              {
                query: query.trim(),
                ai,
                collection: project ? "project" : "personal",
                ownerProjectId,
                limit: 100,
                offset,
              },
              abort.signal,
            );
            abort.signal.throwIfAborted();
            all = [...all, ...result.items];
            total = result.total;
            offset = all.length;
            message = result.fallback
              ? "aiSearchFallback"
              : result.partial
                ? "aiSearchPartial"
                : "";
            if (!result.items.length) break;
          }
          setItems(all);
          setNotice(query.trim() && ai ? message : "");
        } catch (e) {
          if (!abort.signal.aborted)
            setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (!abort.signal.aborted) setBusy(false);
        }
      },
      query.trim() ? (ai ? 600 : 200) : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [ownerProjectId, query, ai, composing, refresh, !!draft, tab]);
  useEffect(() => {
    if (tab !== "creative" || overlay || draft) return;
    const frame = requestAnimationFrame(() =>
      search.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [overlay, !!draft, tab]);

  function switchTab(value: typeof tab) {
    setTab(value);
    if (value === "library") setLibraryVisited(true);
    setAddMenu(false);
    setFolderMenu(undefined);
  }

  function toggleFolder(id: string, force?: boolean) {
    setActive(id);
    setExpanded((old) => {
      const next = new Set(old);
      if (force ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function openFolderAction(action: FolderAction) {
    setFolderMenu(undefined);
    setAddMenu(false);
    setFolderError("");
    setFolderName(action.type === "rename" ? action.folder!.name : "");
    setFolderAction(action);
  }
  async function submitFolder() {
    if (!folderAction || savingFolder) return;
    setSavingFolder(true);
    setFolderError("");
    try {
      if (folderAction.type === "create") {
        const folder = await p.request("createCreativeFolder", {
          name: folderName,
          projectId: ownerProjectId,
          parentId: folderAction.parentId ?? null,
        });
        if (folder.parentId) toggleFolder(folder.parentId, true);
        toggleFolder(folder.id, true);
      } else if (folderAction.type === "rename") {
        await p.request("renameCreativeFolder", {
          id: folderAction.folder!.id,
          revision: folderAction.folder!.revision,
          name: folderName,
        });
      } else
        await p.request("removeCreativeFolder", {
          id: folderAction.folder!.id,
          revision: folderAction.folder!.revision,
        });
      setFolderAction(undefined);
      refreshList();
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingFolder(false);
    }
  }
  function beginIncoming(resources: Resource[], files?: File[]) {
    if ((files?.length ?? resources.length) > 100) {
      p.notify(p.t("importLimit"));
      return;
    }
    completedUploads.current = [];
    setImportError("");
    setProgress("");
    setIncoming({ resources, files, destination });
  }
  async function confirmIncoming(target: Destination) {
    if (!incoming || transfer.current) return;
    const abort = new AbortController();
    transfer.current = abort;
    setWorking(true);
    setImportError("");
    try {
      const files = incoming.files ?? [];
      for (let i = completedUploads.current.length; i < files.length; i++) {
        const media = await upload(
          p.request,
          projectId,
          files[i]!,
          (n) =>
            setProgress(`${p.t("uploading")} ${i + 1}/${files.length} · ${n}%`),
          abort.signal,
        );
        completedUploads.current.push({
          kind: media.mime.startsWith("video/") ? "video" : "image",
          media,
        });
        abort.signal.throwIfAborted();
      }
      setProgress(p.t("saving"));
      setCommitting(true);
      const resources = uniqueResources([
        ...incoming.resources,
        ...completedUploads.current,
      ]);
      // Keep this final commit visible until the host reports its outcome.
      await p.request("addCreativeResources", { resources, ...target });
      if (abort.signal.aborted) return;
      reveal.current = target.folderId ?? undefined;
      setProject(!!target.ownerProjectId);
      switchTab("creative");
      setSelectionVersion((n) => n + 1);
      if (target.folderId) toggleFolder(target.folderId, true);
      setQuery("");
      setIncoming(undefined);
      completedUploads.current = [];
      refreshList();
      p.notify(p.t("assetCreated"));
    } catch (e) {
      if (!abort.signal.aborted)
        setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      transfer.current = undefined;
      setWorking(false);
      setCommitting(false);
      setProgress("");
    }
  }
  function hover(e: React.PointerEvent, id: string) {
    if (
      assetMenu ||
      folderMenu ||
      e.pointerType === "touch" ||
      (pointer.current.x === e.clientX && pointer.current.y === e.clientY)
    )
      return;
    pointer.current = { x: e.clientX, y: e.clientY };
    setActive(id);
  }
  function keydown(e: KeyboardEvent) {
    if (
      overlay ||
      draft ||
      e.defaultPrevented ||
      e.nativeEvent.isComposing ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      assetMenu ||
      (e.target as Element).closest('[role="menu"]')
    )
      return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (tab === "creative" && query) setQuery("");
      else onClose();
      return;
    }
    if (tab !== "creative") return;
    const inInput = !!(e.target as Element).closest("input,textarea");
    const rows = [
      ...(tree.current?.querySelectorAll<HTMLElement>("[data-library-row]") ??
        []),
    ];
    if (["ArrowDown", "ArrowUp"].includes(e.key) && rows.length) {
      e.preventDefault();
      e.stopPropagation();
      const current = rows.findIndex((r) => r.dataset.libraryRow === active),
        delta = e.key === "ArrowDown" ? 1 : -1;
      const next =
        rows[
          current < 0
            ? 0
            : Math.max(0, Math.min(rows.length - 1, current + delta))
        ]!;
      setActive(next.dataset.libraryRow);
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest" });
    } else if (
      !inInput &&
      folders.some((f) => f.id === active) &&
      ["ArrowLeft", "ArrowRight"].includes(e.key)
    ) {
      e.preventDefault();
      e.stopPropagation();
      toggleFolder(active!, e.key === "ArrowRight");
    } else if (
      !inInput &&
      !(e.target as Element).closest("button") &&
      [" ", "Enter"].includes(e.key)
    ) {
      const item = items.find((a) => a.id === active);
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === " ") setPreview(item.references[0]);
      else onAdd(item.references, item);
    }
  }
  function assetRow(item: CreativeAsset) {
    const show = (anchor: HTMLElement) =>
      assetHover.enter(anchor, {
        id: item.id,
        resource: item.references[0]!,
        name: item.name,
        createdAt: item.createdAt,
        onApply: () => onAdd(item.references, item),
        onExpand: () => setPreview(item.references[0]),
      });
    return (
      <div
        key={item.id}
        data-library-row={item.id}
        data-active={active === item.id || assetMenu === item.id}
        tabIndex={0}
        className={css.creativeAssetRow}
        aria-label={item.name}
        onFocus={() => setActive(item.id)}
        onPointerEnter={(e) => {
          if (e.pointerType !== "touch") show(e.currentTarget);
        }}
        onPointerMove={(e) => {
          const moved =
            pointer.current.x !== e.clientX || pointer.current.y !== e.clientY;
          hover(e, item.id);
          if (moved && e.pointerType !== "touch") show(e.currentTarget);
        }}
        onPointerLeave={assetHover.leave}
        onClick={() => {
          assetHover.dismiss();
          onAdd(item.references, item);
        }}
      >
        <AssetThumbnail p={p} resource={item.references[0]!} />
        <span>{item.name}</span>
        <div
          className={css.creativeRowActions}
          onClick={(e) => e.stopPropagation()}
        >
          <Menu
            portal
            open={assetMenu === item.id}
            onClose={() => setAssetMenu(undefined)}
            anchor={
              <Button
                aria-label={`${item.name} · ${p.t("more")}`}
                aria-haspopup="menu"
                aria-expanded={assetMenu === item.id}
                onClick={() => {
                  assetHover.dismiss();
                  setActive(item.id);
                  setAssetMenu(assetMenu === item.id ? undefined : item.id);
                }}
              >
                <Icon name="more" size={18} />
              </Button>
            }
            items={[
              {
                id: "rename",
                label: p.t("rename"),
                icon: <Icon name="edit" />,
              },
              {
                id: "move",
                label: p.t("moveAsset"),
                icon: <Icon name="folder" />,
              },
              {
                id: "copy",
                label: p.t("copyAsset"),
                icon: <Icon name="copy" />,
              },
              {
                id: "download",
                label: p.t("download"),
                icon: <Icon name="download" />,
              },
              { type: "separator", id: "separator" },
              {
                id: "delete",
                label: p.t("confirmDeleteAsset"),
                icon: <Icon name="trash" />,
                danger: true,
              },
            ]}
            onSelect={(id) => {
              setAssetMenu(undefined);
              if (id === "download") {
                void (async () => {
                  for (const resource of item.references) {
                    const saved = await downloadMedia(p.request, projectId, {
                      ...resource,
                      label: item.name,
                      text: "",
                    });
                    if (!saved) break;
                  }
                })().catch((e) => p.notify(String(e.message ?? e)));
              } else setAssetAction({ type: id as AssetAction["type"], item });
            }}
          />
        </div>
      </div>
    );
  }
  function folderTree(parentId: string | null, depth = 0): React.ReactNode {
    return folders
      .filter((f) => f.parentId === parentId)
      .map((folder) => {
        const open = expanded.has(folder.id),
          contents = items.filter((a) => a.folderId === folder.id),
          children = folders.some((f) => f.parentId === folder.id);
        return (
          <div key={folder.id} className={css.creativeFolder}>
            <div
              className={css.creativeFolderRow}
              data-active={active === folder.id || folderMenu === folder.id}
              onPointerMove={(e) => hover(e, folder.id)}
            >
              <button
                data-library-row={folder.id}
                aria-expanded={open}
                onFocus={() => setActive(folder.id)}
                onClick={() => toggleFolder(folder.id)}
              >
                <span className={css.folderAngle} data-open={open}>
                  <Icon name="down" size={14} />
                </span>
                <span className={css.folderGlyph}>
                  <Icon name="folder" size={25} />
                </span>
                <span>{folder.name}</span>
              </button>
              <Menu
                portal
                open={folderMenu === folder.id}
                onClose={() => setFolderMenu(undefined)}
                anchor={
                  <Button
                    className={css.folderMore}
                    aria-label={`${folder.name} · ${p.t("more")}`}
                    onClick={() => {
                      setActive(folder.id);
                      setFolderMenu(
                        folderMenu === folder.id ? undefined : folder.id,
                      );
                    }}
                  >
                    <Icon name="more" size={18} />
                  </Button>
                }
                items={[
                  {
                    id: "upload",
                    label: p.t("upload"),
                    icon: <Icon name="upload" />,
                  },
                  {
                    id: "library",
                    label: p.t("fromAssetLibrary"),
                    icon: <Icon name="folder" />,
                  },
                  { type: "separator", id: "divider" },
                  {
                    id: "create",
                    label: p.t("newFolder"),
                    icon: <Icon name="plus" />,
                  },
                  {
                    id: "rename",
                    label: p.t("rename"),
                    icon: <Icon name="edit" />,
                  },
                  {
                    id: "delete",
                    label: p.t("deleteFolder"),
                    icon: <Icon name="trash" />,
                  },
                ]}
                onSelect={(id) => {
                  setFolderMenu(undefined);
                  if (id === "upload") input.current?.click();
                  else if (id === "library") setPicker("add");
                  else
                    openFolderAction({
                      type: id as FolderAction["type"],
                      folder,
                      parentId: folder.id,
                    });
                }}
              />
            </div>
            {open && (
              <div className={css.creativeFolderContents}>
                {folderTree(folder.id, depth + 1)}
                {busy ? (
                  <div className={css.folderLoading}>{p.t("opening")}</div>
                ) : (
                  contents.map(assetRow)
                )}
                {!busy && !children && !contents.length && (
                  <div className={css.folderEmpty}>{p.t("folderEmpty")}</div>
                )}
              </div>
            )}
          </div>
        );
      });
  }
  return (
    <section
      className={`${css.libraryPanel} ${css.creativePanel}`}
      data-studio-assets
      aria-label={p.t("assets")}
      onKeyDown={keydown}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!draft && !overlay) {
          const files = Array.from(e.dataTransfer.files);
          if (files.length) beginIncoming([], files);
        }
      }}
    >
      <AssetHoverPreview p={p} hover={assetHover} />
      {assetAction && (
        <CreativeAssetAction
          key={`${assetAction.type}:${assetAction.item.id}`}
          p={p}
          action={assetAction}
          onClose={() => setAssetAction(undefined)}
          onChanged={(item) => {
            if (item?.folderId && item.ownerProjectId === ownerProjectId)
              reveal.current = item.folderId;
            refreshList();
          }}
        />
      )}
      {draft ? (
        <AssetEditor
          key={`${draft.record?.id ?? "new"}:${draft.value.references.length}`}
          p={p}
          draft={draft}
          onBack={() => {
            setDraft(undefined);
            refreshList();
          }}
          onChanged={refreshList}
          onAdd={onAdd}
          onPreview={setPreview}
          onLibrary={(value) => {
            setDraft(value);
            setPicker("references");
          }}
        />
      ) : (
        <>
          <header className={css.libraryHeader}>
            <strong>{p.t("assets")}</strong>
            {tab === "creative" && (
              <Menu
                portal
                open={addMenu}
                onClose={() => setAddMenu(false)}
                anchor={
                  <Button
                    className={css.tool}
                    aria-label={p.t("addResources")}
                    onClick={() => setAddMenu(!addMenu)}
                  >
                    <Icon name="plus" />
                  </Button>
                }
                items={[
                  {
                    id: "upload",
                    label: p.t("upload"),
                    icon: <Icon name="upload" />,
                  },
                  {
                    id: "library",
                    label: p.t("fromAssetLibrary"),
                    icon: <Icon name="folder" />,
                  },
                  { type: "separator", id: "divide" },
                  {
                    id: "folder",
                    label: p.t("newFolder"),
                    icon: <Icon name="plus" />,
                  },
                ]}
                onSelect={(id) => {
                  setAddMenu(false);
                  if (id === "upload") input.current?.click();
                  else if (id === "library") switchTab("library");
                  else openFolderAction({ type: "create", parentId: null });
                }}
              />
            )}
            <Button
              className={css.tool}
              aria-label={p.t("close")}
              onClick={onClose}
            >
              <Icon name="close" />
            </Button>
          </header>
          <div
            className={css.libraryTabs}
            role="tablist"
            aria-label={p.t("assetSource")}
          >
            {(["creative", "library"] as const).map((value) => (
              <Button
                key={value}
                id={`${tabsId}-${value}-tab`}
                role="tab"
                aria-selected={tab === value}
                aria-controls={`${tabsId}-${value}-panel`}
                tabIndex={tab === value ? 0 : -1}
                data-active={tab === value}
                onClick={() => switchTab(value)}
                onKeyDown={(e) => {
                  if (
                    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
                  ) {
                    e.preventDefault();
                    e.stopPropagation();
                    switchTab(
                      e.key === "Home"
                        ? "creative"
                        : e.key === "End"
                          ? "library"
                          : tab === "creative"
                            ? "library"
                            : "creative",
                    );
                  }
                }}
              >
                {p.t(value === "creative" ? "creativeAssets" : "assets")}
              </Button>
            ))}
          </div>
          <div
            className={css.libraryTabView}
            role="tabpanel"
            id={`${tabsId}-creative-panel`}
            aria-labelledby={`${tabsId}-creative-tab`}
            hidden={tab !== "creative"}
          >
            <div className={css.librarySearch}>
              <Input
                ref={search}
                className={css.libraryInput}
                icon={<Icon name="search" size={18} />}
                value={query}
                maxLength={300}
                placeholder={p.t(ai ? "semanticSearchHint" : "searchAssets")}
                onChange={(e) => setQuery(e.target.value)}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
              />
              <Tooltip label={p.t(ai ? "aiSearchOn" : "aiSearchOff")}>
                <Button
                  className={css.libraryAI}
                  data-active={ai}
                  aria-label={p.t(ai ? "aiSearchOn" : "aiSearchOff")}
                  aria-pressed={ai}
                  onClick={() => {
                    setAi(!ai);
                    search.current?.focus();
                  }}
                >
                  <Icon name="sparkle" size={19} />
                </Button>
              </Tooltip>
            </div>
            <div ref={tree} className={css.creativeTree}>
              <div className={css.folderHeading}>
                <span>{p.t(query.trim() ? "searchResults" : "folders")}</span>
                <div className={css.folderHeadingActions}>
                  <LibrarySelect
                    label={p.t("assetScope")}
                    value={project ? "project" : "personal"}
                    options={[
                      { id: "personal", label: p.t("personalAssets") },
                      { id: "project", label: p.t("currentProject") },
                    ]}
                    onChange={(value) => {
                      setProject(value === "project");
                      setActive(undefined);
                      setExpanded(new Set());
                    }}
                  />
                  {query && (
                    <Button onClick={() => setQuery("")}>
                      {p.t("clearSearch")}
                    </Button>
                  )}
                </div>
              </div>
              {error ? (
                <div className={css.libraryNotice} role="alert">
                  <span>{error}</span>
                  <Button onClick={refreshList}>{p.t("retry")}</Button>
                </div>
              ) : query.trim() ? (
                <>
                  {notice && !busy && (
                    <div className={css.libraryNotice}>{p.t(notice)}</div>
                  )}
                  {busy
                    ? Array.from({ length: 3 }, (_, i) => (
                        <div key={i} className={css.folderRowSkeleton} />
                      ))
                    : items.map(assetRow)}
                  {!busy && !items.length && (
                    <div className={css.folderEmpty}>{p.t("noAssets")}</div>
                  )}
                </>
              ) : (
                <>
                  {folderTree(null)}
                  {!busy &&
                    items
                      .filter(
                        (a) =>
                          !a.folderId ||
                          !folders.some((f) => f.id === a.folderId),
                      )
                      .map(assetRow)}
                  {!folders.length && busy && (
                    <div className={css.folderRowSkeleton} />
                  )}
                </>
              )}
            </div>
          </div>
          <div
            className={`${css.libraryTabView} ${css.librarySourceView}`}
            role="tabpanel"
            id={`${tabsId}-library-panel`}
            aria-labelledby={`${tabsId}-library-tab`}
            hidden={tab !== "library"}
          >
            {libraryVisited && (
              <ResourceBrowser
                p={p}
                embedded
                visible={tab === "library" && !overlay}
                selectionVersion={selectionVersion}
                onClose={onClose}
                onSelect={(resources) => beginIncoming(resources)}
                onAdd={(resources) => {
                  onAdd(resources);
                  setSelectionVersion((n) => n + 1);
                }}
              />
            )}
          </div>
          <input
            hidden
            ref={input}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.mov"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) beginIncoming([], files);
            }}
          />
        </>
      )}
      {picker && (
        <ResourcePicker
          p={p}
          limit={
            picker === "references"
              ? 24 - (draft?.value.references.length ?? 0)
              : 100
          }
          onClose={() => setPicker(undefined)}
          onSelect={(resources) => {
            if (picker === "references" && draft)
              setDraft({
                ...draft,
                value: {
                  ...draft.value,
                  references: uniqueResources([
                    ...draft.value.references,
                    ...resources,
                  ]),
                },
              });
            else beginIncoming(resources);
            setPicker(undefined);
          }}
        />
      )}
      {incoming && (
        <FolderPicker
          p={p}
          initial={incoming.destination}
          busy={working}
          locked={committing}
          progress={progress}
          error={importError}
          onClose={() => {
            if (committing) return;
            if (working) {
              transfer.current?.abort();
            } else {
              setIncoming(undefined);
              completedUploads.current = [];
            }
          }}
          onConfirm={(target) => void confirmIncoming(target)}
        />
      )}
      <Modal
        open={!!folderAction}
        title={p.t(
          folderAction?.type === "delete"
            ? "deleteFolder"
            : folderAction?.type === "rename"
              ? "renameFolder"
              : "newFolder",
        )}
        className={css.folderNameDialog}
        onClose={() => !savingFolder && setFolderAction(undefined)}
        closeLabel={p.t("close")}
        footer={
          <>
            <Button
              disabled={savingFolder}
              onClick={() => setFolderAction(undefined)}
            >
              {p.t("cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={
                savingFolder ||
                (folderAction?.type !== "delete" && !folderName.trim())
              }
              onClick={() => void submitFolder()}
            >
              {p.t(
                folderAction?.type === "delete"
                  ? "confirmDeleteFolder"
                  : "save",
              )}
            </Button>
          </>
        }
      >
        {folderAction?.type === "delete" ? (
          <p>{p.t("deleteFolderHint")}</p>
        ) : (
          <Input
            autoFocus
            className={css.libraryInput}
            value={folderName}
            maxLength={80}
            placeholder={p.t("folderName")}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.nativeEvent.isComposing &&
                folderName.trim()
              )
                void submitFolder();
            }}
          />
        )}
        {folderError && <p role="alert">{folderError}</p>}
      </Modal>
      {preview && (
        <MediaPreview
          p={p}
          projectId={projectId}
          data={{ ...preview, label: resourceName(preview), text: "" }}
          onClose={() => setPreview(undefined)}
          onAdd={() => {
            onAdd([preview]);
            setPreview(undefined);
          }}
        />
      )}
    </section>
  );
}

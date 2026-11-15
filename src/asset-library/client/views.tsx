import { useState, useRef, useEffect } from "react";
import {
  Button,
  Input,
  Modal,
  Switch,
  Menu,
  Tooltip,
  IconFolderOpenOutlineRegular,
  IconSearchOutlineRegular,
  IconClockOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconPlusOutlineRegular,
  IconCloseOutlineRegular,
  IconCheckOutlineRegular,
  IconSparkleRegular,
  IconChevronRightOutlineRegular,
  IconEllipsisOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PageProps, SharedProps, Request } from "./props.ts";
import type { Asset, SearchHit, Task } from "../shared/contracts.ts";
import type { Key } from "./locales.ts";
import { editKey } from "./asset-editor.ts";
import {
  defaultFilters,
  filterRequest,
  filterCount,
  type Filters,
} from "./filters.ts";
import css from "./library.module.css";
import ui from "../../client/collection.module.css";
import {
  CollectionSearch,
  CollectionTypes,
  CollectionFilterButton,
  CollectionFilterDrawer,
  CollectionMasonry,
} from "../../client/collection-ui.tsx";
import { ProjectCardMenu } from "../../client/project-card.tsx";
import { MediaViewer } from "./media-viewer.tsx";
import type { CollectionAction } from "./folder-browser.tsx";
import { useBrowseScroll } from "./browse-scroll.ts";
import { ChoiceMenu } from "./choice-menu.tsx";
import { TransferDialog, TransferList } from "./transfers.tsx";
import { createPointerIntent, nextGridIndex } from "./keyboard.ts";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
function Empty({
  title,
  help,
  children,
}: {
  title: string;
  help?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={ui.empty}>
      <IconFolderOpenOutlineRegular size={32} />
      <h2>{title}</h2>
      {help && <p>{help}</p>}
      {children}
    </div>
  );
}
function ErrorNotice({ text }: { text?: string }) {
  return text ? (
    <div role="alert" className={css.error}>
      {text}
    </div>
  ) : null;
}
function time(seconds: number) {
  return (
    Math.floor(seconds / 60) +
    ":" +
    Math.floor(seconds % 60)
      .toString()
      .padStart(2, "0")
  );
}
async function mediaBlob(
  request: Request,
  asset: Asset,
  preview: boolean,
  signal: AbortSignal,
) {
  const chunks: Uint8Array[] = [];
  let offset = 0,
    size = 1,
    mime = asset.mime;
  while (offset < size) {
    const r = await request(
      "media",
      { libraryId: asset.libraryId, id: asset.id, preview, offset },
      signal,
    );
    size = r.size;
    mime = r.mime;
    if (size > (preview ? 16 : 256) * 1024 ** 2)
      throw new Error("文件较大，请从库目录打开原文件");
    const b = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    chunks.push(b);
    if (r.nextOffset <= offset) throw new Error("文件读取未完成");
    offset = r.nextOffset;
  }
  return URL.createObjectURL(new Blob(chunks as BlobPart[], { type: mime }));
}
function Preview({
  asset,
  request,
  large = false,
  autoPlay = false,
  suspended = false,
  start,
  t,
  onExpand,
}: {
  asset: Asset;
  t: SharedProps["t"];
  onExpand?(): void;
  request: Request;
  large?: boolean;
  autoPlay?: boolean;
  suspended?: boolean;
  start?: number | null;
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    let objectURL = "";
    setUrl("");
    setError("");
    if (!asset.thumbnail && !large) return;
    void mediaBlob(request, asset, !large, abort.signal)
      .then((u) => {
        objectURL = u;
        if (abort.signal.aborted) URL.revokeObjectURL(u);
        else setUrl(u);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorText(e));
      });
    return () => {
      abort.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [asset.id, asset.thumbnail, large, request]);
  if (!url)
    return (
      <div className={css.previewPlaceholder}>
        {error || <IconFolderOpenOutlineRegular size={large ? 32 : 22} />}
      </div>
    );
  return large ? (
    <MediaViewer
      key={url}
      url={url}
      asset={asset}
      t={t}
      autoPlay={autoPlay}
      suspended={suspended}
      start={start}
      onExpand={onExpand}
    />
  ) : (
    <img
      className={asset.kind === "video" ? css.videoThumbnail : css.thumbnail}
      src={url}
      alt=""
      loading="lazy"
    />
  );
}
/** Full-width asset browser. */
export function Workspace(p: SharedProps) {
  const view = p.useStore((s) => s.view);
  useEffect(() => {
    if (view === "favorites" || view === "recent") p.actions.selectView("all");
  }, [view, p.actions]);
  return (
    <div className={css.workspace}>
      <div className={css.workspaceContent}>
        <Page {...p} />
      </div>
    </div>
  );
}

function LibraryMenu(p: SharedProps) {
  const state = p.useStore((s) => s),
    catalog = p.useCatalog((s) => s);
  const [open, setOpen] = useState(false),
    [dialog, setDialog] = useState<"create" | "open" | null>(null),
    [transfer, setTransfer] = useState<"export" | "import">(),
    [error, setError] = useState("");
  const libs = catalog.data?.libraries ?? [];
  const lib = libs.find((item) => item.id === state.libraryId) ?? libs[0];
  const pending =
    catalog.data?.tasks.filter((task) =>
      ["running", "queued", "retrying"].includes(task.status),
    ).length ?? 0;
  return (
    <>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        portal
        align="end"
        autoFocus
        anchor={
          <Button
            aria-label={p.t("libraryActions")}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            icon={<IconEllipsisOutlineRegular size={18} />}
          />
        }
        items={[
          { id: "all", label: p.t("all") },
          {
            id: "tasks",
            label: p.t("tasks") + (pending ? ` · ${pending}` : ""),
          },
          { type: "separator", id: "library-divider" },
          ...(libs.length > 1
            ? libs.map((item) => ({
                id: "library:" + item.id,
                label: item.name,
              }))
            : []),
          { id: "create", label: p.t("create") },
          { id: "open", label: p.t("open") },
          { id: "importZip", label: p.t("importZip") },
          ...(lib?.available
            ? [{ id: "exportZip", label: p.t("exportZip") }]
            : []),
          ...(lib ? [{ id: "close", label: p.t("closeLibrary") }] : []),
        ]}
        onSelect={(id) => {
          setOpen(false);
          if (id === "all" || id === "tasks") p.actions.selectView(id);
          else if (id === "create" || id === "open") setDialog(id);
          else if (id === "importZip" || id === "exportZip")
            setTransfer(id === "importZip" ? "import" : "export");
          else if (id === "close" && lib)
            void p
              .request("library", { action: "close", id: lib.id })
              .then(p.refresh)
              .catch((e) => setError(errorText(e)));
          else if (id.startsWith("library:"))
            p.actions.selectLibrary(id.slice(8));
        }}
      />
      {dialog && (
        <LibraryDialog {...p} mode={dialog} onClose={() => setDialog(null)} />
      )}
      {transfer && (
        <TransferDialog
          {...p}
          kind={transfer}
          libraryId={lib?.id}
          onClose={() => setTransfer(undefined)}
        />
      )}
      {error && (
        <Modal
          open
          title={p.t("libraryActions")}
          closeLabel={p.t("close")}
          onClose={() => setError("")}
        >
          <ErrorNotice text={error} />
        </Modal>
      )}
    </>
  );
}
export function Page(p: PageProps) {
  const state = p.useStore((s) => s),
    catalog = p.useCatalog((s) => s),
    edits = p.useEdits((s) => s),
    [assets, setAssets] = useState<SearchHit[]>([]),
    [total, setTotal] = useState(0),
    [browsePage, setBrowsePage] = useState(0),
    [searchPage, setSearchPage] = useState(0),
    [query, setQuery] = useState(""),
    [composing, setComposing] = useState(false),
    [busy, setBusy] = useState(true),
    [resultKey, setResultKey] = useState(""),
    [searchNotice, setSearchNotice] = useState(""),
    [filterOpen, setFilterOpen] = useState(false),
    [creatingFolder, setCreatingFolder] = useState(false),
    [collectionAction, setCollectionAction] = useState<{
      collection: { id: string; libraryId: string; name: string };
      action: CollectionAction;
    }>(),
    [error, setError] = useState(""),
    [importing, setImporting] = useState(""),
    [selected, setSelected] = useState<SearchHit | null>(null),
    [focused, setFocused] = useState<SearchHit | null>(null),
    [quick, setQuick] = useState<SearchHit | null>(null),
    [collectionPicker, setCollectionPicker] = useState<SearchHit | null>(null),
    [dialog, setDialog] = useState<"create" | "open" | null>(null);
  const searching = !!query.trim();
  const page = searching ? searchPage : browsePage;
  const setPage = searching ? setSearchPage : setBrowsePage;
  const mediaFilter = state.kind,
    filters = { ...defaultFilters, ...state.filters };
  const filtersKey = JSON.stringify(filters),
    activeFilters =
      filterCount(
        {
          ...filters,
          collectionIds:
            state.view === "collection"
              ? [...new Set([...filters.collectionIds, state.collectionId])]
              : filters.collectionIds,
        },
        mediaFilter,
      ) +
      Number(
        filters.sort !== "default" &&
          (filters.sort !== "newest" || (searching && state.ai)),
      );
  const resetFilters = () => {
    p.actions.resetFilters();
    p.actions.setFilters({ sort: "default" });
    p.actions.selectView("all");
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const pageRoot = useRef<HTMLElement>(null);
  const browseContent = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state.searchOpen) {
      p.actions.openSearch(false);
      searchInput.current?.focus();
    }
  }, [state.searchOpen]);
  const grid = useRef<HTMLDivElement>(null);
  const focusCard = (asset: SearchHit) => {
    const button = grid.current?.querySelector<HTMLButtonElement>(
      `[data-asset-key="${CSS.escape(editKey(asset))}"]`,
    );
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest", inline: "nearest" });
    setFocused(asset);
  };
  const moveGrid = (
    key: string,
    current = focused ?? selected,
    preview = false,
  ) => {
    const buttons = [
      ...(grid.current?.querySelectorAll<HTMLButtonElement>(
        "[data-asset-key]",
      ) ?? []),
    ];
    const index = assets.findIndex(
      (asset) => current && editKey(asset) === editKey(current),
    );
    const next = nextGridIndex(
      buttons.map((button) => button.getBoundingClientRect()),
      index,
      key,
    );
    if (!assets[next]) return;
    if (preview) {
      setFocused(assets[next]);
      setQuick(assets[next]);
    } else {
      focusCard(assets[next]);
      if (selected) setSelected(assets[next]);
    }
  };
  const closeDetail = () => {
    if (selected) {
      void p.flushEdits(editKey(selected));
      const key = editKey(selected);
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLButtonElement>(
            `[data-asset-key="${CSS.escape(key)}"]`,
          )
          ?.focus(),
      );
    }
    setSelected(null);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        e.isComposing ||
        (e.repeat && !e.key.startsWith("Arrow")) ||
        state.searchOpen ||
        quick ||
        document.querySelector('[role="dialog"],[role="menu"]')
      )
        return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        p.actions.openSearch(true);
        return;
      }
      if (
        e.key.startsWith("Arrow") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !isTyping(e.target) &&
        grid.current?.getClientRects().length &&
        e.target instanceof Element
      ) {
        const target = e.target;
        if (
          target.closest(
            'video,audio,[role="slider"],[role="spinbutton"],[role="combobox"],[role="listbox"],[role="tree"],[role="tablist"]',
          ) ||
          !(
            target === document.body ||
            target === document.documentElement ||
            pageRoot.current?.contains(target) ||
            target.closest("[data-asset-sidebar]")
          )
        )
          return;
        e.preventDefault();
        moveGrid(e.key);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (filterOpen) setFilterOpen(false);
        else if (selected) closeDetail();
        else if (state.view !== "all") p.actions.selectView("all");
        else p.onBack();
      }
      if (e.code === "Space" && !isTyping(e.target)) {
        const element = e.target instanceof Element ? e.target : null;
        if (
          element?.closest("video,audio") ||
          (element?.closest("button") && !element.closest("[data-asset-key]"))
        )
          return;
        const asset = focused ?? selected;
        if (asset) {
          e.preventDefault();
          setQuick(asset);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    selected,
    focused,
    assets,
    state.view,
    state.searchOpen,
    quick,
    filterOpen,
  ]);
  useEffect(
    () => () => {
      void p.flushEdits();
    },
    [],
  );
  const libs = catalog.data?.libraries ?? [],
    lib = libs.find((l) => l.id === state.libraryId) ?? libs[0];
  useEffect(() => setFilterOpen(false), [lib?.id]);
  const count = lib?.count ?? 0,
    revision = catalog.data?.tasks.map((t) => t.updatedAt).join("|");
  const folders = (catalog.data?.collections ?? []).filter(
    (folder) => folder.libraryId === lib?.id,
  );
  const collection =
    state.view === "collection"
      ? folders.find((folder) => folder.id === state.collectionId)
      : undefined;
  const requestKey = JSON.stringify([
    lib?.id,
    state.view,
    state.collectionId,
    mediaFilter,
    filtersKey,
    query.trim(),
    state.ai,
    page,
    revision,
    count,
  ]);
  const stale = requestKey !== resultKey;
  const onBrowseScroll = useBrowseScroll(
    browseContent,
    `${lib?.id}:${state.view}:${state.collectionId}`,
    searching,
    !busy && !stale,
  );
  useEffect(() => {
    if (!searching) setBrowsePage(0);
    setSearchPage(0);
    setSelected(null);
    setFocused(null);
    setQuick(null);
  }, [lib?.id, state.view, state.collectionId, mediaFilter, filtersKey]);
  useEffect(() => {
    setSelected(null);
    setFocused(null);
    setQuick(null);
  }, [query.trim()]);
  useEffect(() => {
    if (!lib || composing) return;
    const abort = new AbortController();
    setBusy(true);
    setError("");
    setSearchNotice("");
    const timer = setTimeout(
      async () => {
        const input = {
          ...filterRequest(filters),
          query: query.trim(),
          libraryId: lib.id,
          ai: searching && state.ai,
          favorite: state.view === "favorites" || filters.favorite,
          recent: state.view === "recent",
          collectionId:
            state.view === "collection" ? state.collectionId : undefined,
          kind: mediaFilter,
          limit: 100,
          offset: page * 100,
        };
        try {
          let result;
          try {
            result = await p.request("search", input, abort.signal);
          } catch (error) {
            if (!input.ai || abort.signal.aborted) throw error;
            result = await p.request(
              "search",
              { ...input, ai: false },
              abort.signal,
            );
            if (!abort.signal.aborted) setSearchNotice(p.t("keywordFallback"));
          }
          if (abort.signal.aborted) return;
          setAssets(result.hits);
          setTotal(result.total);
          setResultKey(requestKey);
        } catch (error) {
          if (!abort.signal.aborted) {
            setError(errorText(error));
            setAssets([]);
            setResultKey(requestKey);
          }
        } finally {
          if (!abort.signal.aborted) setBusy(false);
        }
      },
      searching ? (state.ai ? 600 : 200) : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [requestKey, composing, catalog.data]);
  const upload = async (files: FileList | null) => {
    if (!files || !lib) return;
    const errors: string[] = [];
    const destination =
      collection?.id ??
      (filters.collectionIds.length === 1
        ? filters.collectionIds[0]
        : undefined);
    for (const file of Array.from(files)) {
      try {
        setImporting(file.name);
        const start = await p.request("beginUpload", {
          libraryId: lib.id,
          name: file.name,
          size: file.size,
        });
        let offset = start.offset;
        while (offset < file.size) {
          const bytes = new Uint8Array(
            await file.slice(offset, offset + 768 * 1024).arrayBuffer(),
          );
          let text = "";
          for (let i = 0; i < bytes.length; i += 8192)
            text += String.fromCharCode(...bytes.subarray(i, i + 8192));
          const r = await p.request("uploadChunk", {
            libraryId: lib.id,
            id: start.id,
            offset,
            data: btoa(text),
          });
          offset = r.offset;
          setImporting(
            file.name + " · " + Math.round((offset / file.size) * 100) + "%",
          );
        }
        const uploaded = await p.request("finishUpload", {
          libraryId: lib.id,
          id: start.id,
        });
        if (destination)
          await p.request("editAsset", {
            libraryId: lib.id,
            id: uploaded.assetId,
            addCollections: [destination],
          });
        await p.refresh();
      } catch (e) {
        errors.push(file.name + "：" + errorText(e));
      }
    }
    setImporting("");
    setError(errors.join("\n"));
    if (fileInput.current) fileInput.current.value = "";
  };
  return (
    <section ref={pageRoot} className={`${css.page} ${ui.surface}`}>
      <div ref={browseContent} className={ui.content} onScroll={onBrowseScroll}>
        <div className={ui.toolbar}>
          {lib && state.view !== "tasks" && (
            <>
              <CollectionSearch
                ref={searchInput}
                aria-label={p.t("search")}
                placeholder={p.t("searchPlaceholder")}
                value={query}
                maxLength={2000}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSearchPage(0);
                }}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                clearLabel={p.t("clearSearch")}
                onClear={() => {
                  setQuery("");
                  setSearchPage(0);
                }}
                actions={
                  <Tooltip label={p.t(state.ai ? "aiOn" : "aiOff")}>
                    <Button
                      aria-label={p.t(state.ai ? "aiOn" : "aiOff")}
                      aria-pressed={state.ai}
                      onClick={() => p.actions.setAI(!state.ai)}
                    >
                      <IconSparkleRegular size={18} />
                    </Button>
                  </Tooltip>
                }
              />
              <CollectionTypes
                value={mediaFilter}
                label={p.t("filterTitle")}
                options={(["all", "image", "video"] as const).map((value) => ({
                  value,
                  label: p.t(value === "all" ? "any" : value),
                }))}
                onChange={(kind) => p.actions.setKind(kind)}
              />
            </>
          )}
          <div className={ui.resultTools}>
            {lib && state.view !== "tasks" && (
              <CollectionFilterButton
                label={p.t("filter")}
                open={filterOpen}
                count={activeFilters}
                onClick={() => {
                  closeDetail();
                  setFilterOpen(!filterOpen);
                }}
              />
            )}
            <Button
              variant="primary"
              icon={<IconPlusOutlineRegular />}
              disabled={!lib?.available || !!importing}
              onClick={() => fileInput.current?.click()}
            >
              {p.t("import")}
            </Button>
            <LibraryMenu {...p} />
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,.mkv"
          multiple
          hidden
          onChange={(e) => {
            void upload(e.target.files);
          }}
        />
        <ErrorNotice text={catalog.error ?? error} />
        {Object.values(edits)
          .filter((e) => e.status === "error")
          .map((e) => (
            <div
              className={css.error + " " + css.saveError}
              role="alert"
              key={editKey(e.target)}
            >
              <span>
                {e.target.name} · {p.t("saveFailed")}
                <small>{e.error}</small>
              </span>
              <Button
                size="sm"
                onClick={() => {
                  void p.flushEdits(editKey(e.target));
                }}
              >
                {p.t("retry")}
              </Button>
            </div>
          ))}
        {importing && (
          <div role="status" className={css.notice}>
            {importing}
          </div>
        )}
        {searchNotice && (
          <div className={css.notice} role="status">
            {searchNotice}
          </div>
        )}
        {searching && (
          <p className={css.searchScopeHint}>
            {p.t("searchWithin")} · {collection?.name ?? p.t("title")}
          </p>
        )}
        {!catalog.data ? (
          <Empty title={p.t("busy")} />
        ) : state.view === "tasks" ? (
          <TaskList {...p} />
        ) : !lib ? (
          <Empty title={p.t("noLibrary")} help={p.t("noLibraryHelp")}>
            <div className={css.row}>
              <Button variant="primary" onClick={() => setDialog("create")}>
                {p.t("create")}
              </Button>
              <Button onClick={() => setDialog("open")}>{p.t("open")}</Button>
            </div>
          </Empty>
        ) : !lib.available ? (
          <Empty title={p.t("unavailable")} help={lib.error} />
        ) : busy || stale ? (
          <Empty title={p.t("searching")} />
        ) : assets.length === 0 ? (
          <Empty
            title={p.t(
              searching
                ? "noResults"
                : activeFilters
                  ? "noFilterResults"
                  : state.view === "collection"
                    ? "emptyCollection"
                    : "empty",
            )}
            help={p.t(
              searching
                ? "searchEmptyHelp"
                : activeFilters
                  ? "adjustFilters"
                  : state.view === "collection"
                    ? "emptyCollectionHelp"
                    : "emptyHelp",
            )}
          >
            {!searching && !activeFilters && (
              <Button
                variant="primary"
                disabled={!!importing}
                onClick={() => fileInput.current?.click()}
              >
                <IconPlusOutlineRegular size={16} />
                {p.t("import")}
              </Button>
            )}
            {activeFilters > 0 && (
              <Button onClick={resetFilters}>{p.t("resetFilters")}</Button>
            )}
          </Empty>
        ) : (
          <>
            <CollectionMasonry ref={grid}>
              {assets.map((asset) => (
                <AssetCard
                  key={asset.id}
                  {...p}
                  asset={asset}
                  selected={selected?.id === asset.id}
                  tabIndex={
                    focused
                      ? focused.id === asset.id
                        ? 0
                        : -1
                      : asset.id === assets[0]?.id
                        ? 0
                        : -1
                  }
                  onSelect={() => {
                    setFilterOpen(false);
                    setSelected(asset);
                  }}
                  onFocus={() => setFocused(asset)}
                  onPreview={() => setQuick(asset)}
                  onCollect={() => setCollectionPicker(asset)}
                />
              ))}
            </CollectionMasonry>
            {total > 100 && (
              <div className={css.filters}>
                <Button
                  disabled={page === 0}
                  onClick={() => setPage((n) => n - 1)}
                >
                  {p.t("previousPage")}
                </Button>
                <span className={css.muted}>
                  {page * 100 + 1}–{page * 100 + assets.length} / {total}
                </span>
                <Button
                  disabled={(page + 1) * 100 >= total}
                  onClick={() => setPage((n) => n + 1)}
                >
                  {p.t("nextPage")}
                </Button>
              </div>
            )}
          </>
        )}
        {dialog && (
          <LibraryDialog {...p} mode={dialog} onClose={() => setDialog(null)} />
        )}
        {collectionAction && (
          <CollectionActionDialog
            {...p}
            {...collectionAction}
            onClose={() => setCollectionAction(undefined)}
          />
        )}
        {creatingFolder && lib && (
          <CollectionDialog
            {...p}
            libraryId={lib.id}
            onClose={() => setCreatingFolder(false)}
          />
        )}
      </div>
      {filterOpen && (
        <CollectionFilterDrawer
          title={p.t("filterTitle")}
          summary={`${total} ${p.t("items")}`}
          closeLabel={p.t("closeFilters")}
          resetLabel={p.t("resetFilters")}
          doneLabel={p.t("done")}
          active={!!activeFilters}
          onClose={() => setFilterOpen(false)}
          onReset={resetFilters}
        >
          <section className={ui.filterSection}>
            <h3>{p.t("sortBy")}</h3>
            <SortMenu {...p} ai={searching && state.ai} />
          </section>
          <FilterControls
            {...p}
            libraryId={lib?.id}
            collectionScope={collection?.id}
            hideMediaType
            onCreateCollection={() => {
              setFilterOpen(false);
              setCreatingFolder(true);
            }}
            onCollectionAction={(collection, action) => {
              setFilterOpen(false);
              setCollectionAction({ collection, action });
            }}
          />
        </CollectionFilterDrawer>
      )}
      {selected && (
        <Detail
          key={selected.libraryId + selected.id}
          {...p}
          asset={selected}
          previewing={!!quick}
          onClose={closeDetail}
          onPreview={() => setQuick(selected)}
        />
      )}
      {quick && (
        <QuickPreview
          {...p}
          asset={quick}
          onNavigate={(key) => moveGrid(key, quick, true)}
          onClose={() => {
            setQuick(null);
            requestAnimationFrame(() => focusCard(quick));
          }}
        />
      )}
      {collectionPicker && (
        <CollectionPicker
          {...p}
          asset={collectionPicker}
          onClose={() => setCollectionPicker(null)}
        />
      )}
    </section>
  );
}
function SortMenu(p: SharedProps & { ai?: boolean }) {
  const sort = p.useStore((s) => s.filters.sort);
  return (
    <ChoiceMenu
      label={p.t("sortBy")}
      value={!p.ai && sort === "newest" ? "default" : sort}
      options={[
        { id: "default", label: p.t(p.ai ? "relevance" : "newestFirst") },
        ...(p.ai ? [{ id: "newest" as const, label: p.t("newestFirst") }] : []),
        { id: "oldest", label: p.t("oldestFirst") },
        { id: "name", label: p.t("nameOrder") },
        { id: "size", label: p.t("largestFirst") },
      ]}
      onChange={(sort) => p.actions.setFilters({ sort })}
    />
  );
}
function FilterControls(
  p: SharedProps & {
    libraryId?: string;
    allLibraries?: boolean;
    ai?: boolean;
    hideMediaType?: boolean;
    collectionScope?: string;
    onCreateCollection?(): void;
    onCollectionAction?(
      collection: { id: string; libraryId: string; name: string },
      action: CollectionAction,
    ): void;
  },
) {
  const state = p.useStore((s) => s),
    catalog = p.useCatalog((s) => s.data),
    filters = { ...defaultFilters, ...state.filters },
    [collectionQuery, setCollectionQuery] = useState(""),
    [tagQuery, setTagQuery] = useState("");
  const collectionIds = p.collectionScope
    ? [...new Set([...filters.collectionIds, p.collectionScope])]
    : filters.collectionIds;
  const toggleCollection = (id: string) => {
    if (p.collectionScope) p.actions.selectView("all");
    p.actions.setFilters({
      collectionIds: collectionIds.includes(id)
        ? collectionIds.filter((value) => value !== id)
        : [...collectionIds, id],
    });
  };
  const collections = (catalog?.collections ?? []).filter(
    (c) =>
      (p.allLibraries || c.libraryId === p.libraryId) &&
      c.name
        .toLocaleLowerCase()
        .includes(collectionQuery.trim().toLocaleLowerCase()),
  );
  const selectedTags = filterRequest(filters).tags ?? [];
  const tagCounts = new Map<string, number>();
  for (const tag of catalog?.tags ?? []) {
    if (p.allLibraries || tag.libraryId === p.libraryId)
      tagCounts.set(tag.name, (tagCounts.get(tag.name) ?? 0) + tag.count);
  }
  const tags = [...tagCounts].filter(([name]) =>
    name.toLocaleLowerCase().includes(tagQuery.trim().toLocaleLowerCase()),
  );
  const toggleTag = (tag: string) => {
    const next = selectedTags.includes(tag)
      ? selectedTags.filter((name) => name !== tag)
      : [...selectedTags, tag];
    p.actions.setFilters({ tags: next });
  };
  return (
    <div className={css.filterControls}>
      <section className={css.filterSection}>
        {!p.hideMediaType && (
          <>
            <h3>{p.t("mediaType")}</h3>
            <CollectionTypes
              value={state.kind ?? "all"}
              label={p.t("mediaType")}
              options={(["all", "image", "video"] as const).map((value) => ({
                value,
                label: p.t(value === "all" ? "any" : value),
              }))}
              onChange={(kind) => p.actions.setKind(kind)}
            />
          </>
        )}
        <div className={css.filterToggle}>
          <span>{p.t("onlyFavorites")}</span>
          <Switch
            label={p.t("onlyFavorites")}
            checked={filters.favorite}
            onChange={(favorite) => p.actions.setFilters({ favorite })}
          />
        </div>
      </section>
      <section className={css.filterSection}>
        <h3>{p.t("importDate")}</h3>
        <ChoiceMenu
          label={p.t("importDate")}
          value={String(filters.withinDays)}
          options={[
            { id: "0", label: p.t("anyTime") },
            { id: "7", label: p.t("last7Days") },
            { id: "30", label: p.t("last30Days") },
            { id: "90", label: p.t("last90Days") },
          ]}
          onChange={(value) =>
            p.actions.setFilters({ withinDays: Number(value) })
          }
        />
      </section>
      <section className={css.filterSection}>
        <h3>
          {p.t("collections")}
          {collectionIds.length > 0 && (
            <span className={css.filterBadge}>{collectionIds.length}</span>
          )}
        </h3>
        <Input
          className={css.filterSearch}
          icon={<IconSearchOutlineRegular size={14} />}
          aria-label={p.t("searchCollections")}
          placeholder={p.t("searchCollections")}
          value={collectionQuery}
          onChange={(e) => setCollectionQuery(e.target.value)}
        />
        <div className={css.filterCollections}>
          {collections.map((c) => (
            <div key={c.id} className={css.collectionFilterRow}>
              <button
                type="button"
                role="checkbox"
                aria-checked={collectionIds.includes(c.id)}
                className={css.pickerOption}
                onClick={() => toggleCollection(c.id)}
              >
                <IconFolderOpenOutlineRegular size={16} />
                <span className={css.collectionFilterName}>
                  {c.name}
                  {p.allLibraries && (
                    <small>
                      {
                        catalog?.libraries.find((l) => l.id === c.libraryId)
                          ?.name
                      }
                    </small>
                  )}
                </span>
                <span className={css.checkBox}>
                  {collectionIds.includes(c.id) && (
                    <IconCheckOutlineRegular size={14} />
                  )}
                </span>
              </button>
              {p.onCollectionAction && !c.isDefault && (
                <ProjectCardMenu
                  label={p.t("collectionActions") + " · " + c.name}
                  items={[
                    { id: "rename", label: p.t("renameCollection") },
                    { id: "delete", label: p.t("deleteCollection") },
                  ]}
                  onSelect={(action) => {
                    if (action === "rename" || action === "delete")
                      p.onCollectionAction?.(c, action);
                  }}
                />
              )}
            </div>
          ))}
          {!collections.length && (
            <p className={css.filterHelp}>{p.t("noMatchingCollections")}</p>
          )}
        </div>
        {p.onCreateCollection && (
          <Button
            size="sm"
            icon={<IconPlusOutlineRegular size={14} />}
            onClick={p.onCreateCollection}
          >
            {p.t("createCollection")}
          </Button>
        )}
        <p className={css.filterHelp}>{p.t("collectionMatchHint")}</p>
      </section>
      <section className={css.filterSection}>
        <h3>
          {p.t("tags")}
          {selectedTags.length > 0 && (
            <span className={css.filterBadge}>{selectedTags.length}</span>
          )}
        </h3>
        {selectedTags.length > 0 && (
          <div className={css.selectedTags}>
            {selectedTags.map((tag) => (
              <button
                type="button"
                key={tag}
                aria-label={p.t("removeTag") + " " + tag}
                onClick={() => toggleTag(tag)}
              >
                {tag}
                <IconCloseOutlineRegular size={12} />
              </button>
            ))}
          </div>
        )}
        <Input
          className={css.filterSearch}
          icon={<IconSearchOutlineRegular size={14} />}
          aria-label={p.t("searchTags")}
          placeholder={p.t("searchTags")}
          value={tagQuery}
          onChange={(e) => setTagQuery(e.target.value)}
        />
        <div className={css.tagOptions}>
          {tags.map(([tag, count]) => (
            <button
              type="button"
              key={tag}
              aria-pressed={selectedTags.includes(tag)}
              onClick={() => toggleTag(tag)}
            >
              {selectedTags.includes(tag) && (
                <IconCheckOutlineRegular size={12} />
              )}
              <span>{tag}</span>
              <small>{count}</small>
            </button>
          ))}
          {!tags.length && (
            <p className={css.filterHelp}>
              {p.t(tagCounts.size ? "noMatchingTags" : "noTags")}
            </p>
          )}
        </div>
        {selectedTags.length > 0 && (
          <p className={css.filterHelp}>{p.t("filterTagsHint")}</p>
        )}
      </section>
    </div>
  );
}
function LibraryDialog(
  p: SharedProps & { mode: "create" | "open"; onClose(): void },
) {
  const settings = p.useCatalog((s) => s.data?.settings);
  const [mode, setMode] = useState<"local" | "s3">(
    settings?.storageMode ?? "local",
  );
  const [name, setName] = useState(""),
    [path, setPath] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const effectivePath =
    path ||
    (p.mode === "create" && settings?.localDirectory && name.trim()
      ? settings.localDirectory.replace(/[/\\]$/, "") +
        "/" +
        name.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      : "");
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await p.request("library", {
        action: p.mode,
        path: effectivePath,
        ...(p.mode === "create" ? { name, storageMode: mode } : {}),
      });
      if (result.id) p.actions.selectLibrary(result.id);
      await p.refresh();
      p.onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={() => {
        if (!busy) p.onClose();
      }}
      className={css.libraryModal}
      title={p.t(p.mode === "create" ? "create" : "open")}
      closeLabel={p.t("close")}
      backdropBlur={false}
      contentClassName={css.modalContent}
      footer={
        <>
          <Button onClick={p.onClose} disabled={busy}>
            {p.t("cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={
              busy ||
              !effectivePath.trim() ||
              (p.mode === "create" && !name.trim())
            }
            onClick={() => {
              void submit();
            }}
          >
            {p.t(busy ? "busy" : "save")}
          </Button>
        </>
      }
    >
      <div className={css.form}>
        {p.mode === "create" && (
          <label>
            {p.t("libraryName")}
            <Input
              data-modal-autofocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {p.mode === "create" && (
          <label>
            {p.t("storageTitle")}
            <ChoiceMenu<"local" | "s3">
              label={p.t("storageTitle")}
              value={mode}
              options={[
                { id: "local", label: p.t("localStorage") },
                { id: "s3", label: p.t("s3Storage") },
              ]}
              onChange={setMode}
            />
            <span className={css.muted}>
              {p.t(mode === "s3" ? "s3Help" : "localHelp")}
            </span>
          </label>
        )}
        <label>
          {p.t("folderPath")}
          <Input
            data-modal-autofocus={p.mode === "open" || undefined}
            value={effectivePath}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        <Button
          onClick={() => {
            void p
              .pickDirectory()
              .then((value) => {
                if (value) setPath(value);
              })
              .catch((e) => setError(errorText(e)));
          }}
        >
          {p.t("chooseFolder")}
        </Button>
        <p className={css.muted}>{p.t("folderHint")}</p>
        <ErrorNotice text={error} />
      </div>
    </Modal>
  );
}
function SearchDialog(
  p: SharedProps & {
    libraryId?: string;
  },
) {
  const state = p.useStore((s) => s),
    [hits, setHits] = useState<SearchHit[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true),
    [searched, setSearched] = useState(false),
    [filterOpen, setFilterOpen] = useState(false),
    [composing, setComposing] = useState(false),
    [selected, setSelected] = useState(-1),
    [preview, setPreview] = useState<SearchHit | null>(null),
    [unindexed, setUnindexed] = useState(0);
  const filters = {
      ...defaultFilters,
      ...state.filters,
      sort: "default" as const,
    },
    filtersKey = JSON.stringify(filters),
    query = state.query.trim();
  const activeFilters = filterCount(filters, state.kind);
  const loading = busy || composing;
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const abort = useRef<AbortController | null>(null);
  const results = useRef<HTMLDivElement>(null);
  const pointerMoved = useRef(createPointerIntent());
  const focusHit = (index: number) => {
    const option =
      results.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[
        index
      ];
    option?.focus({ preventScroll: true });
    option?.scrollIntoView({ block: "nearest" });
    setSelected(index);
  };
  const moveResult = (key: string, inPreview = false) => {
    if (loading) return;
    const next =
      selected < 0
        ? key === "ArrowUp" || key === "ArrowLeft"
          ? hits.length - 1
          : 0
        : Math.max(
            0,
            Math.min(
              hits.length - 1,
              selected + (key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1),
            ),
          );
    if (!hits[next]) return;
    if (inPreview) {
      setSelected(next);
      setPreview(hits[next]);
    } else focusHit(next);
  };
  const search = async () => {
    clearTimeout(timer.current);
    if (composing) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError("");
    setSearched(false);
    try {
      const r = await p.request(
        "search",
        {
          ...filterRequest(filters),
          query,
          ai: !!query && state.ai,
          ...(!query ? { sort: "newest" as const, limit: 8 } : {}),
          kind: state.kind,
          ...(!state.scopeAll && p.libraryId ? { libraryId: p.libraryId } : {}),
        },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setHits(r.hits);
        setSelected(-1);
        setUnindexed(r.unindexed);
        setSearched(true);
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(errorText(e));
        setHits([]);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    abort.current?.abort();
    setBusy(true);
    setSelected(-1);
    setSearched(false);
    setError("");
    if (!composing) {
      setBusy(true);
      timer.current = setTimeout(
        () => {
          void search();
        },
        !query ? 0 : state.ai ? 700 : 250,
      );
    }
    return () => {
      clearTimeout(timer.current);
      abort.current?.abort();
    };
  }, [
    query,
    state.ai,
    state.kind,
    state.scopeAll,
    p.libraryId,
    filtersKey,
    composing,
  ]);
  return (
    <Modal
      open
      onClose={() => p.actions.openSearch(false)}
      title={p.t("search")}
      closeLabel={p.t("close")}
      backdropBlur={false}
      contentClassName={css.modalContent}
      className={css.searchModal}
      onKeyDownCapture={(e) => {
        if (
          e.key === "Escape" &&
          !e.nativeEvent.isComposing &&
          !document.querySelector('[role="menu"]') &&
          document.querySelectorAll('[role="dialog"]').length === 1
        ) {
          e.preventDefault();
          e.stopPropagation();
          if (filterOpen) setFilterOpen(false);
          else p.actions.openSearch(false);
        }
      }}
    >
      <div
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            if (hits[Math.max(selected, 0)] && !loading)
              setPreview(hits[Math.max(selected, 0)]);
            else void search();
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (hits.length) moveResult(e.key);
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            if (hits.length) moveResult(e.key);
          }
        }}
      >
        <CollectionSearch
          className={ui.pickerSearch}
          data-modal-autofocus
          aria-label={p.t("search")}
          value={state.query}
          placeholder={p.t("searchPlaceholder")}
          onChange={(e) => p.actions.setQuery(e.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          clearLabel={p.t("clearSearch")}
          onClear={() => p.actions.setQuery("")}
          actions={
            <Tooltip label={p.t(state.ai ? "aiOn" : "aiOff")} portal>
              <Button
                aria-label={p.t(state.ai ? "aiOn" : "aiOff")}
                aria-pressed={state.ai}
                onClick={() => p.actions.setAI(!state.ai)}
              >
                <IconSparkleRegular size={18} />
              </Button>
            </Tooltip>
          }
        />
      </div>
      <div className={css.filters}>
        <ChoiceMenu
          compact
          label={p.t("searchScope")}
          value={state.scopeAll ? "all" : "current"}
          options={[
            { id: "current", label: p.t("currentLibrary") },
            { id: "all", label: p.t("allLibraries") },
          ]}
          onChange={(id) => p.actions.setScope(id === "all")}
        />
        <CollectionTypes
          value={state.kind ?? "all"}
          label={p.t("mediaType")}
          options={(["all", "image", "video"] as const).map((value) => ({
            value,
            label: p.t(value === "all" ? "any" : value),
          }))}
          onChange={(kind) => p.actions.setKind(kind)}
        />
        <div className={css.spacer} />
        <CollectionFilterButton
          label={p.t("filter")}
          open={filterOpen}
          count={activeFilters}
          onClick={() => setFilterOpen(!filterOpen)}
        />
      </div>
      <div className={css.searchBody}>
        <div className={css.searchResultsColumn}>
          {(loading || searched) && (
            <div role="status" className={css.searchStatus}>
              {loading ? (
                <>
                  <span className={css.searchSpinner} />
                  {p.t("searching")}
                </>
              ) : query ? (
                hits.length + " " + p.t("items")
              ) : (
                p.t("recent")
              )}
            </div>
          )}
          <ErrorNotice text={error} />
          {error && (
            <Button
              size="sm"
              onClick={() => {
                void search();
              }}
            >
              {p.t("retry")}
            </Button>
          )}
          {searched && query && state.ai && unindexed > 0 && (
            <p className={css.muted}>
              {p.t("unindexedHint")} · {unindexed}
            </p>
          )}
          <div
            className={css.results}
            ref={results}
            role="listbox"
            aria-label={p.t("search")}
            aria-busy={loading}
            onKeyDown={(e) => {
              if (loading || e.nativeEvent.isComposing || isTyping(e.target))
                return;
              if (e.key.startsWith("Arrow")) {
                e.preventDefault();
                moveResult(e.key);
              }
              if ((e.key === "Enter" || e.code === "Space") && hits[selected]) {
                e.preventDefault();
                e.stopPropagation();
                setPreview(hits[selected]);
              }
            }}
          >
            {loading ? (
              <div className={css.searchSkeleton} aria-hidden="true">
                {Array.from(
                  { length: Math.min(hits.length || 4, 6) },
                  (_, index) => (
                    <div className={css.skeletonRow} key={index}>
                      <div className={css.skeletonImage} />
                      <div className={css.skeletonText}>
                        <span />
                        <span />
                      </div>
                    </div>
                  ),
                )}
              </div>
            ) : (
              hits.map((hit, index) => (
                <button
                  key={hit.libraryId + hit.id}
                  role="option"
                  aria-selected={selected === index}
                  tabIndex={
                    selected === index || (selected < 0 && index === 0) ? 0 : -1
                  }
                  className={css.result}
                  onFocus={() => setSelected(index)}
                  onPointerMove={(e) => {
                    if (
                      !pointerMoved.current(e) ||
                      preview ||
                      document.querySelector('[role="menu"]')
                    )
                      return;
                    setSelected(index);
                    if (!isTyping(document.activeElement))
                      e.currentTarget.focus({ preventScroll: true });
                  }}
                  onClick={() => {
                    setSelected(index);
                    setPreview(hit);
                  }}
                >
                  <div className={css.resultImage}>
                    <Preview t={p.t} asset={hit} request={p.request} />
                  </div>
                  <div>
                    <div className={css.filename}>{hit.name}</div>
                    <div className={css.meta}>
                      {p.t(hit.kind)}
                      {hit.start !== null &&
                        " · " +
                          time(hit.start) +
                          "–" +
                          time(hit.end ?? hit.start)}
                    </div>
                  </div>
                </button>
              ))
            )}
            {searched && !loading && !hits.length && (
              <div className={css.searchEmpty}>
                <IconSearchOutlineRegular size={28} />
                <span>
                  {p.t(query || activeFilters ? "noResults" : "empty")}
                </span>
              </div>
            )}
          </div>
        </div>
        {filterOpen && (
          <CollectionFilterDrawer
            title={p.t("filterTitle")}
            closeLabel={p.t("closeFilters")}
            resetLabel={p.t("resetFilters")}
            doneLabel={p.t("done")}
            active={!!activeFilters}
            onClose={() => setFilterOpen(false)}
            onReset={() => p.actions.resetFilters()}
          >
            <FilterControls
              {...p}
              libraryId={p.libraryId}
              allLibraries={state.scopeAll}
              ai={state.ai}
            />
          </CollectionFilterDrawer>
        )}
      </div>
      {preview && (
        <QuickPreview
          {...p}
          asset={preview}
          onNavigate={(key) => moveResult(key, true)}
          onClose={() => {
            setPreview(null);
            requestAnimationFrame(() => focusHit(selected));
          }}
        />
      )}
    </Modal>
  );
}
function Detail(
  p: SharedProps & {
    asset: SearchHit;
    previewing: boolean;
    onClose(): void;
    onPreview(): void;
  },
) {
  const catalog = p.useCatalog((s) => s.data),
    entry = p.useEdits((s) => s[editKey(p.asset)]);
  const draft = { ...p.asset, ...entry?.draft };
  const [tags, setTags] = useState(draft.tags.join(", ")),
    [notes, setNotes] = useState(draft.notes),
    [picker, setPicker] = useState(false);
  const composing = useRef(false),
    key = editKey(p.asset);
  useEffect(
    () => () => {
      void p.flushEdits(key);
    },
    [key],
  );
  const collections =
    catalog?.collections.filter((c) => c.libraryId === p.asset.libraryId) ?? [];
  draft.collectionIds = draft.collectionIds.filter((id) =>
    collections.some((c) => c.id === id),
  );
  const chosen = collections.filter((c) => draft.collectionIds.includes(c.id));
  const setTagsValue = (value: string) =>
    p.editAsset(p.asset, {
      tags: [
        ...new Set(
          value
            .split(/[,，]/)
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ],
    });
  const status = entry?.status ?? "saved";
  return (
    <Modal
      open
      headless
      title={p.t("detail")}
      onClose={p.onClose}
      className={css.detailDialog}
    >
      <header className={css.detailHeader}>
        <h2>{p.t("detail")}</h2>
        <Button
          size="sm"
          aria-label={p.t("close")}
          icon={<IconCloseOutlineRegular size={18} />}
          onClick={p.onClose}
        />
      </header>
      <div className={css.detailLayout}>
        <div className={css.detailMedia}>
          <div className={css.inspectorPreview}>
            <Preview
              t={p.t}
              asset={p.asset}
              request={p.request}
              large
              suspended={p.previewing}
              onExpand={p.onPreview}
              start={p.asset.start}
            />
          </div>
        </div>
        <div className={css.detailInfo}>
          <div className={css.inspectorBody}>
            <div className={css.detailTitle}>
              <h2>{p.asset.name}</h2>
              <button
                className={css.starButton}
                aria-label={p.t("favorite")}
                aria-pressed={draft.collectionIds.length > 0}
                onClick={() => setPicker(true)}
              >
                <IconFolderOpenOutlineRegular size={18} />
              </button>
            </div>
            <div className={css.statusLine}>
              <span
                className={
                  p.asset.status === "ready" ? css.readyDot : css.pendingDot
                }
              />
              {p.t(p.asset.status === "ready" ? "indexed" : "pending")}
            </div>
            <dl className={css.facts}>
              <div>
                <dt>{p.t("fileType")}</dt>
                <dd>{p.asset.name.split(".").pop()?.toUpperCase()}</dd>
              </div>
              <div>
                <dt>{p.t("fileSize")}</dt>
                <dd>{fileSize(p.asset.size)}</dd>
              </div>
              <div>
                <dt>{p.t("importDate")}</dt>
                <dd>{new Date(p.asset.createdAt).toLocaleDateString()}</dd>
              </div>
              {p.asset.duration !== null && (
                <div>
                  <dt>{p.t("duration")}</dt>
                  <dd>{time(p.asset.duration)}</dd>
                </div>
              )}
            </dl>
            <section className={css.detailSection}>
              <div className={css.sectionHeading}>
                <h3>{p.t("collections")}</h3>
                <Button size="sm" onClick={() => setPicker(true)}>
                  {p.t("manageCollections")}
                </Button>
              </div>
              <div className={css.chosenChips}>
                {chosen.slice(0, 4).map((c) => (
                  <span className={css.chosenChip} key={c.id}>
                    <IconFolderOpenOutlineRegular size={14} />
                    <span>{c.name}</span>
                    <button
                      aria-label={p.t("removeFrom") + " " + c.name}
                      onClick={() =>
                        p.editAsset(
                          p.asset,
                          {
                            collectionIds: draft.collectionIds.filter(
                              (id) => id !== c.id,
                            ),
                          },
                          true,
                        )
                      }
                    >
                      <IconCloseOutlineRegular size={12} />
                    </button>
                  </span>
                ))}
                {chosen.length > 4 && (
                  <Button size="sm" onClick={() => setPicker(true)}>
                    +{chosen.length - 4}
                  </Button>
                )}
                {!chosen.length && (
                  <button
                    className={css.emptyCollectionAction}
                    onClick={() => setPicker(true)}
                  >
                    <IconPlusOutlineRegular size={15} />
                    {p.t("addToCollections")}
                  </button>
                )}
              </div>
            </section>
            <section className={css.detailSection}>
              <label className={css.fieldLabel}>
                {p.t("tags")}
                <Input
                  value={tags}
                  placeholder={p.t("tagsHint")}
                  maxLength={4000}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={(e) => {
                    composing.current = false;
                    setTagsValue(e.currentTarget.value);
                  }}
                  onChange={(e) => {
                    setTags(e.target.value);
                    if (!composing.current) setTagsValue(e.target.value);
                  }}
                  onBlur={() => {
                    setTagsValue(tags);
                    void p.flushEdits(key);
                  }}
                />
              </label>
              <div className={css.tagRow}>
                {draft.tags.map((tag, i) => (
                  <span className={css.tag} key={i}>
                    {tag}
                  </span>
                ))}
              </div>
            </section>
            <section className={css.detailSection}>
              <label className={css.fieldLabel}>
                {p.t("notes")}
                <textarea
                  className={css.textarea}
                  value={notes}
                  maxLength={10000}
                  placeholder={p.t("notesHint")}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={(e) => {
                    composing.current = false;
                    p.editAsset(p.asset, { notes: e.currentTarget.value });
                  }}
                  onChange={(e) => {
                    setNotes(e.target.value);
                    if (!composing.current)
                      p.editAsset(p.asset, { notes: e.target.value });
                  }}
                  onBlur={() => {
                    p.editAsset(p.asset, { notes });
                    void p.flushEdits(key);
                  }}
                />
              </label>
            </section>
          </div>
          <footer className={css.autosaveStatus} role="status">
            <span>
              {p.t(
                status === "error"
                  ? "saveFailed"
                  : status === "saved"
                    ? "saved"
                    : "autoSaving",
              )}
            </span>
            {status === "error" ? (
              <Button
                size="sm"
                onClick={() => {
                  void p.flushEdits(key);
                }}
              >
                {p.t("retry")}
              </Button>
            ) : (
              <kbd>Esc</kbd>
            )}
          </footer>
        </div>
      </div>
      {picker && (
        <CollectionPicker
          {...p}
          asset={p.asset}
          onClose={() => setPicker(false)}
        />
      )}
    </Modal>
  );
}
function CollectionPicker(
  p: SharedProps & { asset: SearchHit; onClose(): void },
) {
  const data = p.useCatalog((s) => s.data),
    entry = p.useEdits((s) => s[editKey(p.asset)]),
    [query, setQuery] = useState("");
  const collections =
    data?.collections.filter((c) => c.libraryId === p.asset.libraryId) ?? [];
  const members = (entry?.draft.collectionIds ?? p.asset.collectionIds).filter(
    (id) => collections.some((c) => c.id === id),
  );
  const visible = collections.filter((c) =>
    c.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
  );
  return (
    <Modal
      open
      title={p.t("manageCollections")}
      closeLabel={p.t("close")}
      onClose={p.onClose}
      backdropBlur={false}
      className={css.collectionPicker}
      contentClassName={css.modalContent + " " + css.collectionPickerContent}
    >
      <Input
        data-modal-autofocus
        value={query}
        icon={<IconSearchOutlineRegular />}
        placeholder={p.t("searchCollections")}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className={css.pickerSummary}>
        {members.length} {p.t("collectionsSelected")}
      </p>
      <div className={css.collectionPickerList}>
        {visible.map((c) => (
          <button
            key={c.id}
            type="button"
            role="checkbox"
            aria-checked={members.includes(c.id)}
            className={css.pickerOption}
            onClick={() =>
              p.editAsset(
                p.asset,
                {
                  collectionIds: members.includes(c.id)
                    ? members.filter((id) => id !== c.id)
                    : [...members, c.id],
                },
                true,
              )
            }
          >
            <IconFolderOpenOutlineRegular size={17} />
            <span>{c.name}</span>
            <span className={css.checkBox}>
              {members.includes(c.id) && <IconCheckOutlineRegular size={14} />}
            </span>
          </button>
        ))}
        {!visible.length && (
          <p className={css.muted}>
            {p.t(
              collections.length
                ? "noMatchingCollections"
                : "createCollectionHint",
            )}
          </p>
        )}
      </div>
    </Modal>
  );
}
function QuickPreview(
  p: SharedProps & {
    asset: SearchHit;
    onClose(): void;
    onNavigate?(key: string): void;
  },
) {
  return (
    <Modal
      open
      headless
      title={p.asset.name}
      onClose={p.onClose}
      backdropBlur={false}
      className={css.quickPreview}
      onKeyDownCapture={(e) => {
        if (
          !e.nativeEvent.isComposing &&
          !isTyping(e.target) &&
          !(e.target instanceof HTMLVideoElement) &&
          e.key.startsWith("Arrow") &&
          p.onNavigate
        ) {
          e.preventDefault();
          e.stopPropagation();
          p.onNavigate(e.key);
        }
        if (
          e.code === "Space" &&
          !e.nativeEvent.isComposing &&
          !isTyping(e.target) &&
          !(e.target instanceof HTMLVideoElement)
        ) {
          e.preventDefault();
          e.stopPropagation();
          p.onClose();
        }
      }}
    >
      <header className={css.quickLookHeader}>
        <button
          type="button"
          data-modal-autofocus
          aria-label={p.t("close")}
          title={p.t("close") + " · Esc"}
          onClick={p.onClose}
        >
          <IconCloseOutlineRegular size={14} />
        </button>
        <span title={p.asset.name}>{p.asset.name}</span>
        <kbd>Space</kbd>
      </header>
      <div className={css.quickPreviewMedia}>
        <Preview
          t={p.t}
          asset={p.asset}
          request={p.request}
          large
          autoPlay
          start={p.asset.start}
        />
      </div>
    </Modal>
  );
}
function isTyping(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      'input,textarea,select,[contenteditable="true"],[role="textbox"]',
    )
  );
}
function fileSize(bytes: number) {
  return bytes >= 1024 ** 2
    ? (bytes / 1024 ** 2).toFixed(1) + " MB"
    : Math.max(1, Math.round(bytes / 1024)) + " KB";
}
function AssetCard(
  p: SharedProps & {
    asset: SearchHit;
    selected: boolean;
    tabIndex: number;
    onSelect(): void;
    onFocus(): void;
    onPreview(): void;
    onCollect(): void;
  },
) {
  const edit = p.useEdits((s) => s[editKey(p.asset)]);
  const collections = p.useCatalog((s) => s.data?.collections ?? []);
  const a = { ...p.asset, ...edit?.draft };
  a.collectionIds = a.collectionIds.filter((id) =>
    collections.some((c) => c.id === id && c.libraryId === a.libraryId),
  );
  return (
    <article className={css.card + " " + (p.selected ? css.selectedCard : "")}>
      <button
        className={css.cardOpen}
        aria-label={a.name}
        aria-pressed={p.selected}
        tabIndex={p.tabIndex}
        data-asset-key={editKey(a)}
        onClick={p.onSelect}
        onFocus={p.onFocus}
        onDoubleClick={p.onPreview}
        title={a.name}
      >
        <div className={css.cardImage}>
          <Preview t={p.t} asset={a} request={p.request} />
          <span className={css.typeChip}>{p.t(a.kind)}</span>
          {a.kind === "video" && (
            <span className={css.duration}>
              {a.duration ? time(a.duration) : p.t("video")}
            </span>
          )}
        </div>
      </button>
      <button
        className={css.cardFavorite}
        aria-label={p.t("favorite") + " · " + a.name}
        aria-pressed={a.collectionIds.length > 0}
        tabIndex={p.selected ? 0 : -1}
        onClick={p.onCollect}
      >
        <IconFolderOpenOutlineRegular size={18} />
      </button>
    </article>
  );
}
function CollectionActionDialog(
  p: SharedProps & {
    action: CollectionAction;
    onClose(): void;
    collection: {
      id: string;
      libraryId: string;
      name: string;
    };
  },
) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await p.request("collection", {
        libraryId: p.collection.libraryId,
        action: "delete",
        id: p.collection.id,
      });
      p.actions.collectionDeleted(p.collection.id);
      await p.refresh();
      p.onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {p.action === "rename" && (
        <CollectionDialog
          {...p}
          libraryId={p.collection.libraryId}
          existing={p.collection}
          onClose={() => p.onClose()}
        />
      )}
      {p.action === "delete" && (
        <Modal
          open
          title={p.t("deleteCollection")}
          closeLabel={p.t("close")}
          onClose={() => {
            if (!busy) p.onClose();
          }}
          backdropBlur={false}
          className={css.collectionDeleteDialog}
          footer={
            <>
              <Button disabled={busy} onClick={() => p.onClose()}>
                {p.t("cancel")}
              </Button>
              <Button
                variant="primary"
                className={css.dangerButton}
                disabled={busy}
                onClick={() => void remove()}
              >
                {p.t(busy ? "busy" : "deleteCollection")}
              </Button>
            </>
          }
        >
          <p className={css.deleteCollectionName}>{p.collection.name}</p>
          <p className={css.muted}>{p.t("deleteCollectionHelp")}</p>
          <ErrorNotice text={error} />
        </Modal>
      )}
    </>
  );
}
function CollectionDialog(
  p: SharedProps & {
    libraryId: string;
    existing?: { id: string; name: string };
    onClose(): void;
  },
) {
  const [name, setName] = useState(p.existing?.name ?? ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await p.request("collection", {
        libraryId: p.libraryId,
        action: p.existing ? "rename" : "create",
        id: p.existing?.id,
        name,
      });
      await p.refresh();
      p.onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={p.onClose}
      title={p.t(p.existing ? "renameCollection" : "createCollection")}
      closeLabel={p.t("close")}
      backdropBlur={false}
      className={css.libraryModal + " " + css.collectionEditDialog}
      contentClassName={css.modalContent + " " + css.collectionEditContent}
      footer={
        <>
          <Button onClick={p.onClose}>{p.t("cancel")}</Button>
          <Button
            variant="primary"
            disabled={busy || !name.trim()}
            onClick={() => {
              void save();
            }}
          >
            {p.t("save")}
          </Button>
        </>
      }
    >
      <div className={css.form}>
        <label>
          {p.t("collectionName")}
          <Input
            data-modal-autofocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.nativeEvent.isComposing &&
                name.trim()
              )
                void save();
            }}
          />
        </label>
        <ErrorNotice text={error} />
      </div>
    </Modal>
  );
}
function TaskList(p: SharedProps) {
  const data = p.useCatalog((s) => s.data),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const tasks = (data?.tasks ?? []).filter(
    (task) => task.status !== "completed" && task.status !== "cancelled",
  );
  const hasTransfers = data?.transfers.some(
    (job) => job.status !== "completed" && job.status !== "cancelled",
  );
  const act = (task: Task, action: "pause" | "resume" | "retry" | "cancel") => {
    setBusy(task.id);
    setError("");
    void p
      .request("task", { libraryId: task.libraryId, id: task.id, action })
      .then(p.refresh)
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(""));
  };
  return (
    <>
      <TransferList {...p} />
      <ErrorNotice text={error} />
      {!tasks.length && !hasTransfers && <Empty title={p.t("noTasks")} />}
      {tasks.length > 0 && (
        <div className={css.taskList}>
          {tasks.map((task) => (
            <div key={task.id} className={css.task}>
              <div className={css.taskHeading}>
                <div>
                  <div className={css.filename}>{task.name}</div>
                  <div className={css.meta}>
                    {p.t(task.status)} · {p.t(("stage_" + task.stage) as Key)} ·{" "}
                    {task.progress}%
                  </div>
                </div>
                <div className={css.row}>
                  {["running", "queued", "retrying"].includes(task.status) && (
                    <Button
                      size="sm"
                      disabled={busy === task.id}
                      onClick={() => act(task, "pause")}
                    >
                      {p.t("pause")}
                    </Button>
                  )}
                  {task.status === "paused" && (
                    <Button
                      size="sm"
                      disabled={busy === task.id}
                      onClick={() => act(task, "resume")}
                    >
                      {p.t("resume")}
                    </Button>
                  )}
                  {task.status === "failed" && (
                    <Button
                      size="sm"
                      disabled={busy === task.id}
                      onClick={() => act(task, "retry")}
                    >
                      {p.t("retry")}
                    </Button>
                  )}
                  {!["completed", "cancelled"].includes(task.status) && (
                    <Button
                      size="sm"
                      disabled={busy === task.id}
                      onClick={() => act(task, "cancel")}
                    >
                      {p.t("cancel")}
                    </Button>
                  )}
                </div>
              </div>
              <progress
                className={css.progress}
                max={100}
                value={task.progress}
              />
              {task.error && <p className={css.taskError}>{task.error}</p>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

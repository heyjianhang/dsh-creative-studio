import { CollectionSearch, CollectionTypes } from "./collection-ui.tsx";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Button,
  Menu,
  Modal,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { Output, Resource } from "../shared/contracts.ts";
import type { CanvasProps } from "./props.ts";
import {
  AssetThumbnail,
  LibrarySelect,
  resourceKey,
  resourceName,
} from "./asset-shared.tsx";
import { MediaPreview } from "./media-preview.tsx";
import { SaveToLibrary } from "./save-to-library.tsx";
import { downloadMedia } from "./media-source.ts";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";
import { FolderBrowser } from "../asset-library/client/folder-browser.tsx";
import { useBrowseScroll } from "../asset-library/client/browse-scroll.ts";

const mediaKinds = ["all", "image", "video"] as const;

type ResourceBrowserProps = {
  p: CanvasProps;
  onClose(): void;
  limit?: number;
  visible?: boolean;
  selectionVersion?: number;
} & (
  | { embedded: true; onAdd(refs: Resource[]): void; onSelect?: never }
  | { embedded?: false; onAdd?: never; onSelect(refs: Resource[]): void }
);

export function ResourcePicker(props: ResourceBrowserProps) {
  return <ResourceBrowser {...props} />;
}

export function ResourceBrowser({
  p,
  onClose,
  onSelect,
  onAdd,
  limit = 100,
  embedded,
  visible = true,
  selectionVersion = 0,
}: ResourceBrowserProps) {
  const projectId = p.useStudio((s) => s.current!.id);
  const [query, setQuery] = useState(""),
    [ai, setAi] = useState(true),
    [composing, setComposing] = useState(false);
  const [folderId, setFolderId] = useState<string>();
  const resultsElement = useRef<HTMLDivElement>(null);
  const searching = !!query.trim();
  const [libraryId, setLibraryId] = useState("all"),
    [kind, setKind] = useState<(typeof mediaKinds)[number]>("all");
  const [info, setInfo] = useState<Output<"libraryInfo">>();
  const [result, setResult] = useState<Output<"searchLibrary">>();
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Record<string, Resource>>({}),
    [active, setActive] = useState<string>();
  const [preview, setPreview] = useState<{
    resource: Resource;
    start?: number;
  }>();
  const [signature, setSignature] = useState("");
  const search = useRef<HTMLInputElement>(null),
    grid = useRef<HTMLDivElement>(null);
  const key = JSON.stringify([
    query.trim(),
    ai,
    libraryId,
    folderId,
    kind,
    refresh,
  ]);
  const stale = key !== signature;
  const rows = stale ? [] : (result?.hits ?? []);
  const browseCache = useRef<{
    scope: string;
    result: Output<"searchLibrary"> | undefined;
    signature: string;
    offset: number;
  }>();
  const browseScope = `${libraryId}:${folderId ?? ""}:${kind}:${ai}:${refresh}`;
  function changeQuery(value: string) {
    if (!searching && value.trim())
      browseCache.current = { scope: browseScope, result, signature, offset };
    setQuery(value);
    if (!value.trim() && browseCache.current?.scope === browseScope) {
      setResult(browseCache.current.result);
      setSignature(browseCache.current.signature);
      setOffset(browseCache.current.offset);
    } else setOffset(0);
  }
  const chosen = Object.values(selected);
  const selectionOrder = new Map(
    Object.keys(selected).map((id, index) => [id, index + 1]),
  );
  const folders = (info?.folders ?? []).filter(
    (folder) => libraryId === "all" || folder.libraryId === libraryId,
  );
  const onBrowseScroll = useBrowseScroll(
    resultsElement,
    `${libraryId}:${folderId ?? ""}`,
    searching,
    !stale && !busy,
  );
  const [menu, setMenu] = useState<string>();
  useEffect(() => setSelected({}), [selectionVersion]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() =>
      search.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    setError("");
    void p
      .request("libraryInfo", {}, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setInfo(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e.message ?? e));
      });
    return () => abort.abort();
  }, [refresh, visible]);
  useEffect(() => {
    if (
      composing ||
      !visible ||
      !info?.available ||
      !info.libraries.some((l) => l.available)
    )
      return;
    const abort = new AbortController();
    setBusy(true);
    setError("");
    const timer = setTimeout(
      async () => {
        try {
          const data = await p.request(
            "searchLibrary",
            {
              query: query.trim(),
              ai,
              kind,
              libraryId: libraryId === "all" ? undefined : libraryId,
              collectionId: folderId,
              offset,
              limit: 24,
            },
            abort.signal,
          );
          if (abort.signal.aborted) return;
          setResult((old) => ({
            ...data,
            hits:
              offset && signature === key
                ? [
                    ...new Map(
                      [...(old?.hits ?? []), ...data.hits].map((h) => [
                        resourceKey({ kind: h.kind, asset: h }),
                        h,
                      ]),
                    ).values(),
                  ]
                : data.hits,
          }));
          setSignature(key);
          if (signature !== key) setActive(undefined);
        } catch (e) {
          if (!abort.signal.aborted)
            setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (!abort.signal.aborted) setBusy(false);
        }
      },
      !query.trim() || offset ? 0 : ai ? 600 : 200,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [key, offset, composing, visible, info]);
  function toggle(resource: Resource) {
    const id = resourceKey(resource);
    setActive(id);
    setSelected((old) => {
      const next = { ...old };
      if (next[id]) delete next[id];
      else if (Object.keys(next).length < limit) next[id] = resource;
      return next;
    });
  }
  const activeIndex = () =>
    rows.findIndex((r) => resourceKey({ kind: r.kind, asset: r }) === active);
  const closePreview = () => {
    setPreview(undefined);
    requestAnimationFrame(() => {
      const card = grid.current?.children[activeIndex()];
      (card instanceof HTMLElement ? card : search.current)?.focus();
    });
  };
  function keydown(e: KeyboardEvent) {
    if (
      !visible ||
      preview ||
      menu ||
      e.defaultPrevented ||
      e.nativeEvent.isComposing ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      (e.target as Element).closest('[role="menu"]')
    )
      return;
    if (embedded && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (query) {
        changeQuery("");
      } else if (chosen.length) setSelected({});
      else onClose();
      return;
    }
    const inSearch = e.target === search.current;
    const inGrid =
      e.target instanceof Element && grid.current?.contains(e.target);
    if (!inSearch && !inGrid) return;
    if (
      (e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        (inGrid && ["ArrowLeft", "ArrowRight"].includes(e.key))) &&
      rows.length &&
      !busy
    ) {
      e.preventDefault();
      e.stopPropagation();
      const i = activeIndex();
      const columns = 2;
      const delta =
        e.key === "ArrowDown"
          ? columns
          : e.key === "ArrowUp"
            ? -columns
            : e.key === "ArrowRight"
              ? 1
              : -1;
      const next =
        i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + delta));
      setActive(resourceKey({ kind: rows[next]!.kind, asset: rows[next]! }));
      const card = grid.current?.children[next] as HTMLElement;
      card?.focus({ preventScroll: true });
      card?.scrollIntoView({ block: "nearest" });
    } else if (
      inGrid &&
      !(e.target as Element).closest("button") &&
      [" ", "Enter"].includes(e.key)
    ) {
      const row = rows[activeIndex()];
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === " ")
        setPreview({
          resource: { kind: row.kind, asset: row },
          start: row.start ?? undefined,
        });
      else toggle({ kind: row.kind, asset: row });
    }
  }
  const footer = (
    <>
      <span className={css.librarySelectionCount} aria-live="polite">
        {p.t("selected")} {chosen.length}
      </span>
      {embedded ? (
        <>
          <SaveToLibrary p={p} projectId={projectId} resources={chosen} />
          <Tooltip label={p.t("clearSelection")} portal>
            <Button
              aria-label={p.t("clearSelection")}
              disabled={!chosen.length}
              onClick={() => setSelected({})}
            >
              <Icon name="close" size={16} />
            </Button>
          </Tooltip>
        </>
      ) : (
        <Button onClick={onClose}>{p.t("cancel")}</Button>
      )}
      <Button
        variant="primary"
        disabled={!chosen.length}
        onClick={() => (embedded ? onAdd(chosen) : onSelect(chosen))}
      >
        {p.t(embedded ? "addAsset" : "next")}
      </Button>
    </>
  );
  const content = (
    <div
      data-studio-assets
      data-embedded={embedded || undefined}
      className={css.resourceBrowser}
      onKeyDown={keydown}
    >
      <CollectionSearch
        ref={search}
        className={css.resourceSearch}
        value={query}
        maxLength={300}
        aria-label={p.t("searchAssets")}
        placeholder={p.t(ai ? "semanticSearchHint" : "searchAssets")}
        onChange={(e) => changeQuery(e.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        clearLabel={p.t("clearSearch")}
        onClear={() => changeQuery("")}
        actions={
          <Tooltip label={p.t(ai ? "aiSearchOn" : "aiSearchOff")}>
            <Button
              aria-label={p.t(ai ? "aiSearchOn" : "aiSearchOff")}
              aria-pressed={ai}
              onClick={() => {
                setAi(!ai);
                setOffset(0);
                search.current?.focus();
              }}
            >
              <Icon name="sparkle" size={18} />
            </Button>
          </Tooltip>
        }
      />
      <div className={css.libraryFilters}>
        {(info?.libraries.filter((library) => library.available).length ?? 0) >
          1 && (
          <LibrarySelect
            label={p.t("selectLibrary")}
            value={libraryId}
            options={[
              { id: "all", label: p.t("allLibraries") },
              ...(info?.libraries
                .filter((l) => l.available)
                .map((l) => ({ id: l.id, label: l.name })) ?? []),
            ]}
            onChange={(value) => {
              setLibraryId(value);
              setFolderId(undefined);
              setOffset(0);
            }}
          />
        )}
        {embedded ? (
          <>
            <LibrarySelect
              folder
              label={p.t("folders")}
              value={folderId ?? "all"}
              options={[
                { id: "all", label: p.t("allAssets") },
                ...folders.map(({ id, name }) => ({ id, label: name })),
              ]}
              onChange={(id) => {
                setFolderId(id === "all" ? undefined : id);
                setOffset(0);
              }}
            />
          </>
        ) : (
          <>
            <span className={css.resourceCount}>
              {!stale && !busy
                ? `${result?.total ?? 0} ${p.t("assetResults")}`
                : ""}
            </span>
          </>
        )}
        <CollectionTypes
          value={kind}
          label={p.t("mediaType")}
          options={mediaKinds.map((value) => ({ value, label: p.t(value) }))}
          onChange={(value) => {
            setKind(value);
            setOffset(0);
          }}
        />
        {!embedded && (libraryId !== "all" || kind !== "all") && (
          <Button
            className={css.libraryReset}
            onClick={() => {
              setLibraryId("all");
              setFolderId(undefined);
              setKind("all");
              setOffset(0);
            }}
          >
            {p.t("reset")}
          </Button>
        )}
      </div>
      <div
        ref={resultsElement}
        className={css.resourceResults}
        onScroll={onBrowseScroll}
      >
        {!embedded && !searching && (
          <FolderBrowser
            folders={folders}
            currentId={folderId}
            rootLabel={p.t("allAssets")}
            label={p.t("folders")}
            onNavigate={(id) => {
              setFolderId(id);
              setOffset(0);
            }}
          />
        )}
        {!embedded && searching && (
          <p className={css.resourceSearchScope}>
            {p.t("searchWithin")} ·{" "}
            {folders.find((folder) => folder.id === folderId)?.name ??
              p.t("allAssets")}
          </p>
        )}
        {error ? (
          <div className={css.libraryEmpty} role="alert">
            <p>{error}</p>
            <Button onClick={() => setRefresh((n) => n + 1)}>
              {p.t("retry")}
            </Button>
          </div>
        ) : info &&
          (!info.available || !info.libraries.some((l) => l.available)) ? (
          <div className={css.libraryEmpty}>
            <Icon name="folder" size={28} />
            <strong>
              {p.t(info.available ? "noLibraries" : "assetMissing")}
            </strong>
            <Button onClick={() => setRefresh((n) => n + 1)}>
              {p.t("reloadAsset")}
            </Button>
          </div>
        ) : (
          <>
            {!stale &&
              query.trim() &&
              ai &&
              (result?.fallback || !!result?.unindexed) && (
                <div className={css.libraryNotice}>
                  {p.t(
                    result?.fallback ? "aiSearchFallback" : "aiSearchPartial",
                  )}
                </div>
              )}
            <div
              ref={grid}
              className={`${css.resourceList} ${css.resourceThumbnails}`}
              aria-busy={busy}
            >
              {stale
                ? Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className={css.resourceListSkeleton}>
                      <div />
                      {!embedded && <span />}
                    </div>
                  ))
                : rows.map((hit) => {
                    const resource: Resource = { kind: hit.kind, asset: hit },
                      id = resourceKey(resource);
                    return (
                      <div
                        key={id}
                        className={`${css.creativeAssetRow} ${css.resourceListRow}`}
                        data-active={menu === id}
                        data-selected={!!selected[id] || undefined}
                        tabIndex={0}
                        aria-label={hit.name}
                        title={embedded ? hit.name : undefined}
                        onFocus={() => setActive(id)}
                        onClick={() => {
                          toggle(resource);
                        }}
                      >
                        <AssetThumbnail p={p} resource={resource} />
                        {!embedded && <span>{hit.name}</span>}
                        <Button
                          className={css.resourceListCheck}
                          aria-label={`${p.t("select")} · ${hit.name}`}
                          aria-pressed={!!selected[id]}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(resource);
                          }}
                        >
                          {selected[id] ? (
                            embedded ? (
                              selectionOrder.get(id)
                            ) : (
                              <Icon name="check" size={16} />
                            )
                          ) : (
                            <span className={css.resourceUnchecked} />
                          )}
                        </Button>
                        <div
                          className={css.creativeRowActions}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Menu
                            portal
                            open={menu === id}
                            onClose={() => setMenu(undefined)}
                            anchor={
                              <Button
                                aria-label={`${hit.name} · ${p.t("more")}`}
                                aria-haspopup="menu"
                                aria-expanded={menu === id}
                                onClick={() => {
                                  setActive(id);
                                  setMenu(menu === id ? undefined : id);
                                }}
                              >
                                <Icon name="more" size={18} />
                              </Button>
                            }
                            items={[
                              {
                                id: "preview",
                                label: p.t("previewAsset"),
                                icon: <Icon name="fit" />,
                              },
                              {
                                id: "download",
                                label: p.t("download"),
                                icon: <Icon name="download" />,
                              },
                            ]}
                            onSelect={(action) => {
                              setMenu(undefined);
                              if (action === "preview")
                                setPreview({
                                  resource,
                                  start: hit.start ?? undefined,
                                });
                              else
                                void downloadMedia(p.request, projectId, {
                                  ...resource,
                                  label: hit.name,
                                  text: "",
                                }).catch((e) =>
                                  p.notify(String(e.message ?? e)),
                                );
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
            </div>
            {!stale &&
              !busy &&
              !rows.length &&
              (embedded || searching || !!folderId || !folders.length) && (
                <div className={css.libraryEmpty}>
                  <Icon name="search" size={28} />
                  <strong>{p.t("noAssets")}</strong>
                </div>
              )}
            {!stale && rows.length < (result?.total ?? 0) && (
              <Button
                className={css.libraryMore}
                disabled={busy}
                onClick={() => setOffset(rows.length)}
              >
                {p.t(busy ? "opening" : "loadMore")}
              </Button>
            )}
          </>
        )}
      </div>
      {embedded && <div className={css.resourceBrowserFooter}>{footer}</div>}
      {preview && (
        <MediaPreview
          p={p}
          projectId={projectId}
          data={{
            ...preview.resource,
            label: resourceName(preview.resource),
            text: "",
          }}
          start={preview.start}
          onClose={closePreview}
          onAdd={
            onAdd
              ? () => {
                  onAdd([preview.resource]);
                  closePreview();
                }
              : undefined
          }
          saveToLibrary={embedded}
        />
      )}
    </div>
  );
  return embedded ? (
    content
  ) : (
    <Modal
      open
      title={p.t("fromAssetLibrary")}
      className={css.resourceDialog}
      onClose={() => (preview ? closePreview() : onClose())}
      closeLabel={p.t("close")}
      footer={footer}
    >
      {content}
    </Modal>
  );
}

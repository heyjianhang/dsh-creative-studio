import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Button,
  Input,
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
import { AssetHoverPreview, useAssetHover } from "./asset-hover.tsx";
import { downloadMedia } from "./media-source.ts";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";

interface ResourceBrowserProps {
  p: CanvasProps;
  onClose(): void;
  onSelect(refs: Resource[]): void;
  limit?: number;
  embedded?: boolean;
  visible?: boolean;
  onAdd?(refs: Resource[]): void;
  selectionVersion?: number;
}

export function ResourcePicker(props: ResourceBrowserProps) {
  return <ResourceBrowser {...props} />;
}

export function ResourceBrowser({
  p,
  onClose,
  onSelect,
  onAdd,
  limit = 100,
  embedded = false,
  visible = true,
  selectionVersion = 0,
}: ResourceBrowserProps) {
  const projectId = p.useStudio((s) => s.current!.id);
  const [query, setQuery] = useState(""),
    [ai, setAi] = useState(true),
    [composing, setComposing] = useState(false);
  const [libraryId, setLibraryId] = useState("all"),
    [kind, setKind] = useState<"all" | "image" | "video">("all");
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
    grid = useRef<HTMLDivElement>(null),
    pointer = useRef({ x: NaN, y: NaN });
  const key = JSON.stringify([query.trim(), ai, libraryId, kind, refresh]);
  const stale = key !== signature;
  const rows = stale ? [] : (result?.hits ?? []);
  const chosen = Object.values(selected);
  const [menu, setMenu] = useState<string>();
  const assetHover = useAssetHover(visible && !preview && !menu && !stale);
  useEffect(() => assetHover.dismiss(), [key]);
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
  const closePreview = () => {
    setPreview(undefined);
    requestAnimationFrame(() =>
      (
        grid.current?.querySelector<HTMLElement>(`[data-active="true"]`) ??
        search.current
      )?.focus(),
    );
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
        setQuery("");
        setOffset(0);
      } else if (chosen.length) setSelected({});
      else onClose();
      return;
    }
    const input = (e.target as Element).closest("input,textarea");
    if (
      (e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        (!input && ["ArrowLeft", "ArrowRight"].includes(e.key))) &&
      rows.length &&
      !busy
    ) {
      e.preventDefault();
      e.stopPropagation();
      const i = rows.findIndex(
        (r) => resourceKey({ kind: r.kind, asset: r }) === active,
      );
      const columns = 1;
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
      !input &&
      !(e.target as Element).closest("button") &&
      [" ", "Enter"].includes(e.key)
    ) {
      const row = rows.find(
        (r) => resourceKey({ kind: r.kind, asset: r }) === active,
      );
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === " ")
        setPreview({
          resource: { kind: row.kind, asset: row },
          start: row.start ?? undefined,
        });
      else if (embedded && onAdd && !e.shiftKey)
        onAdd([{ kind: row.kind, asset: row }]);
      else toggle({ kind: row.kind, asset: row });
    }
  }
  const footer = (
    <>
      <span className={css.librarySelectionCount} aria-live="polite">
        {chosen.length ? `${chosen.length} ${p.t("selected")}` : ""}
      </span>
      {embedded ? (
        <Button disabled={!chosen.length} onClick={() => setSelected({})}>
          {p.t("clearSelection")}
        </Button>
      ) : (
        <Button onClick={onClose}>{p.t("cancel")}</Button>
      )}
      <div className={css.resourceFooterActions}>
        {embedded && (
          <Button disabled={!chosen.length} onClick={() => onSelect(chosen)}>
            {p.t("saveSelection")}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!chosen.length}
          onClick={() => (embedded ? onAdd?.(chosen) : onSelect(chosen))}
        >
          {p.t(embedded ? "addAsset" : "next")}
        </Button>
      </div>
    </>
  );
  const content = (
    <div data-studio-assets className={css.resourceBrowser} onKeyDown={keydown}>
      <AssetHoverPreview p={p} hover={assetHover} />
      <div className={css.librarySearch}>
        <Input
          ref={search}
          className={css.libraryInput}
          icon={<Icon name="search" size={18} />}
          value={query}
          maxLength={300}
          placeholder={p.t(ai ? "semanticSearchHint" : "searchAssets")}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
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
              setOffset(0);
              search.current?.focus();
            }}
          >
            <Icon name="sparkle" size={21} />
          </Button>
        </Tooltip>
      </div>
      <div className={css.libraryFilters}>
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
            setOffset(0);
          }}
        />
        <LibrarySelect
          label={p.t("mediaType")}
          value={kind}
          options={(["all", "image", "video"] as const).map((id) => ({
            id,
            label: p.t(id),
          }))}
          onChange={(value) => {
            setKind(value as typeof kind);
            setOffset(0);
          }}
        />
        {(libraryId !== "all" || kind !== "all") && (
          <Button
            className={css.libraryReset}
            onClick={() => {
              setLibraryId("all");
              setKind("all");
              setOffset(0);
            }}
          >
            {p.t("reset")}
          </Button>
        )}
      </div>
      <div className={css.resourceResults}>
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
            <div ref={grid} className={css.resourceList} aria-busy={busy}>
              {stale
                ? Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className={css.resourceListSkeleton}>
                      <div />
                      <span />
                    </div>
                  ))
                : rows.map((hit) => {
                    const resource: Resource = { kind: hit.kind, asset: hit },
                      id = resourceKey(resource);
                    const show = (anchor: HTMLElement) =>
                      assetHover.enter(anchor, {
                        id,
                        resource,
                        name: hit.name,
                        start: hit.start ?? undefined,
                        applyLabel: embedded ? undefined : p.t("next"),
                        onApply: () =>
                          embedded && onAdd
                            ? onAdd([resource])
                            : onSelect([resource]),
                        onExpand: () =>
                          setPreview({
                            resource,
                            start: hit.start ?? undefined,
                          }),
                      });
                    return (
                      <div
                        key={id}
                        className={`${css.creativeAssetRow} ${css.resourceListRow}`}
                        data-active={active === id || menu === id}
                        tabIndex={0}
                        aria-label={hit.name}
                        onFocus={() => setActive(id)}
                        onPointerEnter={(e) => {
                          if (e.pointerType !== "touch") show(e.currentTarget);
                        }}
                        onPointerLeave={assetHover.leave}
                        onPointerMove={(e) => {
                          if (
                            !menu &&
                            e.pointerType !== "touch" &&
                            (pointer.current.x !== e.clientX ||
                              pointer.current.y !== e.clientY)
                          ) {
                            pointer.current = { x: e.clientX, y: e.clientY };
                            setActive(id);
                            show(e.currentTarget);
                          }
                        }}
                        onClick={(event) => {
                          assetHover.dismiss();
                          if (embedded && !event.shiftKey && onAdd)
                            onAdd([resource]);
                          else toggle(resource);
                        }}
                      >
                        <AssetThumbnail p={p} resource={resource} />
                        <span>{hit.name}</span>
                        <Button
                          className={css.resourceListCheck}
                          aria-label={p.t("selected")}
                          aria-pressed={!!selected[id]}
                          onClick={(e) => {
                            e.stopPropagation();
                            assetHover.dismiss();
                            toggle(resource);
                          }}
                        >
                          {selected[id] ? (
                            <Icon name="check" size={16} />
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
                                  assetHover.dismiss();
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
                              ...(embedded
                                ? [
                                    {
                                      id: "save",
                                      label: p.t("saveSelection"),
                                      icon: <Icon name="folder" />,
                                    },
                                  ]
                                : []),
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
                              else if (action === "save") onSelect([resource]);
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
            {!stale && !busy && !rows.length && (
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
      {embedded && chosen.length > 0 && (
        <div className={css.resourceBrowserFooter}>{footer}</div>
      )}
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
          onSave={
            embedded
              ? () => {
                  onSelect([preview.resource]);
                  setPreview(undefined);
                }
              : undefined
          }
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

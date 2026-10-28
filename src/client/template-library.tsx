import { useEffect, useRef, useState } from "react";
import {
  Button,
  Input,
  Menu,
  Modal,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { Shared } from "./props.ts";
import {
  templateCategories,
  type PromptTemplate,
  type TemplateCategory,
  type TemplateResult,
} from "../shared/template-contracts.ts";
import { Icon, type IconName } from "./icons.tsx";
import css from "./studio.module.css";
import {
  templateDefaultReferences,
  templateImageSources,
} from "../shared/template-images.ts";

function TemplateImage({
  item,
  eager = false,
}: {
  item: PromptTemplate;
  eager?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const sources = templateImageSources(item.coverUrl);
  return item.coverUrl && sources[attempt] ? (
    <img
      src={sources[attempt]}
      alt={item.title}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setAttempt((value) => value + 1)}
    />
  ) : (
    <div className={css.templateImageFallback}>
      <Icon name="image" size={32} />
    </div>
  );
}

function FilterMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      portal
      minWidthFromAnchor
      selectedId={value}
      className={css.templateFilterMenu}
      anchor={
        <Button
          onClick={() => setOpen(!open)}
          aria-label={label}
          aria-expanded={open}
        >
          <span>{options.find((o) => o.id === value)?.label ?? label}</span>
          <Icon name="down" size={14} />
        </Button>
      }
      items={options}
      onSelect={(id) => {
        onChange(id);
        setOpen(false);
      }}
    />
  );
}

export function TemplateLibrary({
  p,
  onUse,
}: {
  p: Shared;
  onUse(item: PromptTemplate, referenceUrls: string[]): Promise<void>;
}) {
  const [type, setType] = useState<"image" | "video" | "canvas">("image");
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState<TemplateCategory>(),
    [source, setSource] = useState(""),
    [model, setModel] = useState(""),
    [favoritesOnly, setFavoritesOnly] = useState(false);
  const [result, setResult] = useState<TemplateResult>(),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(false);
  const [detail, setDetail] = useState<PromptTemplate>(),
    [using, setUsing] = useState(false),
    [favoriteBusy, setFavoriteBusy] = useState<string[]>([]);
  const [referenceUrls, setReferenceUrls] = useState<string[]>([]);
  const refreshRequested = useRef(false);
  const categoriesRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<PromptTemplate[]>([]);
  const criteria = JSON.stringify({
    query,
    category,
    source,
    model,
    favoritesOnly,
  });
  const previousCriteria = useRef(criteria);
  const favoriteWrites = useRef(new Set<string>());
  const favoriteVersion = useRef(0);
  useEffect(() => {
    const row = categoriesRef.current;
    if (!row) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      const pixels =
        delta *
        (event.deltaMode === 1
          ? 32
          : event.deltaMode === 2
            ? row.clientWidth
            : 1);
      const next = Math.max(
        0,
        Math.min(row.scrollWidth - row.clientWidth, row.scrollLeft + pixels),
      );
      if (Math.abs(next - row.scrollLeft) < 0.5) return;
      event.preventDefault();
      row.scrollLeft = next;
    };
    row.addEventListener("wheel", wheel, { passive: false });
    return () => row.removeEventListener("wheel", wheel);
  }, [type]);
  useEffect(() => {
    if (type !== "image") {
      setBusy(false);
      return;
    }
    const changed = previousCriteria.current !== criteria;
    previousCriteria.current = criteria;
    if (changed && offset) {
      setOffset(0);
      return;
    }
    const abort = new AbortController();
    const refresh = refreshRequested.current;
    const version = favoriteVersion.current;
    setBusy(true);
    setError(false);
    const timer = setTimeout(
      () => {
        refreshRequested.current = false;
        void p
          .request(
            "templates",
            {
              query,
              category,
              source: source || undefined,
              model: model || undefined,
              favoritesOnly,
              offset: changed ? 0 : offset,
              limit: 48,
              refresh,
            },
            abort.signal,
          )
          .then((data) => {
            if (abort.signal.aborted) return;
            setResult((old) =>
              version === favoriteVersion.current
                ? data
                : { ...data, favorites: old?.favorites ?? data.favorites },
            );
            setItems((old) =>
              offset && !changed
                ? [
                    ...old,
                    ...data.items.filter(
                      (n) => !old.some((o) => o.id === n.id),
                    ),
                  ]
                : data.items,
            );
          })
          .catch(() => {
            if (!abort.signal.aborted) setError(true);
          })
          .finally(() => {
            if (!abort.signal.aborted) setBusy(false);
          });
      },
      query ? 220 : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [type, criteria, offset, revision, p.request]);

  const reset = () => {
    setQuery("");
    setCategory(undefined);
    setSource("");
    setModel("");
    setFavoritesOnly(false);
    setOffset(0);
  };
  const favorite = async (item: PromptTemplate) => {
    if (favoriteWrites.current.has(item.id)) return;
    favoriteVersion.current++;
    favoriteWrites.current.add(item.id);
    setFavoriteBusy([...favoriteWrites.current]);
    try {
      const ids = await p.request("favoriteTemplate", {
        id: item.id,
        favorite: !result?.favorites.includes(item.id),
      });
      setResult((old) => old && { ...old, favorites: ids });
      if (favoritesOnly) {
        setOffset(0);
        setRevision((v) => v + 1);
      }
    } catch {
      p.notify(p.t("templateFavoriteFailed"));
    } finally {
      favoriteWrites.current.delete(item.id);
      setFavoriteBusy([...favoriteWrites.current]);
    }
  };
  const use = async (item: PromptTemplate) => {
    setUsing(true);
    try {
      await onUse(item, referenceUrls);
      setDetail(undefined);
    } catch (e) {
      p.notify((e as Error).message);
    } finally {
      setUsing(false);
    }
  };
  const openDetail = (item: PromptTemplate) => {
    setReferenceUrls(templateDefaultReferences(item));
    setDetail(item);
  };
  const referenceChoices = detail
    ? [
        ...new Set(
          [
            ...detail.referenceImageUrls.filter(
              (url) => url !== detail.coverUrl,
            ),
            detail.coverUrl,
          ].filter(Boolean),
        ),
      ].slice(0, 24)
    : [];
  const activeFilters = !!(
    query ||
    category ||
    source ||
    model ||
    favoritesOnly
  );
  const sourceName = (item: PromptTemplate) =>
    result?.sources.find((s) => s.id === item.sourceId)?.name ?? item.sourceId;
  return (
    <section className={css.templateLibrary} aria-label={p.t("templates")}>
      <div className={css.templateTypeRow}>
        <div
          className={css.templateTypes}
          role="tablist"
          aria-label={p.t("templateType")}
          onKeyDown={(e) => {
            const types = ["image", "video", "canvas"] as const;
            const index = types.indexOf(type);
            const next =
              e.key === "ArrowRight"
                ? (index + 1) % 3
                : e.key === "ArrowLeft"
                  ? (index + 2) % 3
                  : e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? 2
                      : -1;
            if (next < 0) return;
            e.preventDefault();
            setType(types[next]!);
            e.currentTarget
              .querySelectorAll<HTMLButtonElement>('[role="tab"]')
              [next]?.focus();
          }}
        >
          {(["image", "video", "canvas"] as const).map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={type === id}
              tabIndex={type === id ? 0 : -1}
              onClick={() => setType(id)}
            >
              <Icon
                name={(id === "canvas" ? "grid" : id) as IconName}
                size={18}
              />
              {p.t(id === "canvas" ? "templateCanvas" : id)}
            </button>
          ))}
        </div>
        {type === "image" && (
          <div className={css.templateSearchTools}>
            <div className={css.templateSearch}>
              <Icon name="search" size={18} />
              <Input
                aria-label={p.t("templateSearch")}
                placeholder={p.t("templateSearch")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <Button
                  size="sm"
                  aria-label={p.t("clearSearch")}
                  onClick={() => setQuery("")}
                >
                  <Icon name="close" size={14} />
                </Button>
              )}
            </div>
            <Tooltip label={p.t("templateRefresh")} portal>
              <Button
                className={css.templateRefresh}
                aria-label={p.t("templateRefresh")}
                disabled={busy}
                onClick={() => {
                  refreshRequested.current = true;
                  setOffset(0);
                  setRevision((v) => v + 1);
                }}
              >
                <Icon name="refresh" size={18} />
              </Button>
            </Tooltip>
          </div>
        )}
      </div>
      {type !== "image" ? (
        <div className={css.templateEmpty}>
          <div className={css.templateEmptyArt}>
            <Icon name={type === "video" ? "video" : "grid"} size={38} />
          </div>
          <h2>
            {p.t(type === "video" ? "templateVideoSoon" : "templateCanvasSoon")}
          </h2>
          <p>
            {p.t(
              type === "video"
                ? "templateVideoSoonHint"
                : "templateCanvasSoonHint",
            )}
          </p>
          <Button onClick={() => setType("image")}>
            {p.t("templateBrowseImages")}
            <Icon name="arrow" size={16} />
          </Button>
        </div>
      ) : (
        <>
          <div
            className={css.templateCategories}
            aria-label={p.t("templatePurpose")}
          >
            <button
              aria-pressed={!category}
              onClick={() => setCategory(undefined)}
            >
              {p.t("all")}
            </button>
            <div className={css.templateCategoryScroll} ref={categoriesRef}>
              {templateCategories.map((id) => (
                <button
                  key={id}
                  aria-pressed={category === id}
                  onClick={() => setCategory(id)}
                  onFocus={(e) =>
                    e.currentTarget.scrollIntoView({
                      block: "nearest",
                      inline: "nearest",
                    })
                  }
                >
                  {p.t(`templateCategory_${id}`)}
                </button>
              ))}
            </div>
          </div>
          <div className={css.templateFilterRow}>
            <div
              className={css.templateViews}
              role="group"
              aria-label={p.t("view")}
            >
              <button
                aria-pressed={!favoritesOnly}
                onClick={() => setFavoritesOnly(false)}
              >
                {p.t("templateExplore")}
              </button>
              <button
                aria-pressed={favoritesOnly}
                onClick={() => setFavoritesOnly(true)}
              >
                <Icon name="star" size={15} />
                {p.t("templateFavorites")}
              </button>
            </div>
            <div className={css.templateFilters}>
              <FilterMenu
                label={p.t("templateAllSources")}
                value={source}
                onChange={setSource}
                options={[
                  { id: "", label: p.t("templateAllSources") },
                  ...(result?.sources ?? []).map((s) => ({
                    id: s.id,
                    label: s.name,
                  })),
                ]}
              />
              <FilterMenu
                label={p.t("templateAllModels")}
                value={model}
                onChange={setModel}
                options={[
                  { id: "", label: p.t("templateAllModels") },
                  ...(result?.models ?? []).map((m) => ({ id: m, label: m })),
                ]}
              />
              {activeFilters && (
                <Button size="sm" onClick={reset}>
                  {p.t("reset")}
                </Button>
              )}
            </div>
          </div>
          <div className={css.srOnly} role="status">
            {busy
              ? p.t("templateLoading")
              : result
                ? `${result.total.toLocaleString()} ${p.t("templateCount")}`
                : ""}
          </div>
          {error && (
            <div className={css.templateError} role="alert">
              <span>
                {p.t(result ? "templateRefreshFailed" : "templateLoadFailed")}
              </span>
              <Button
                size="sm"
                onClick={() => {
                  refreshRequested.current = true;
                  setRevision((v) => v + 1);
                }}
              >
                {p.t("retry")}
              </Button>
            </div>
          )}
          <div className={css.templateGrid} aria-busy={busy}>
            {items.map((item, index) => (
              <article key={item.id} className={css.templateCard}>
                <button
                  className={css.templateOpen}
                  onClick={() => openDetail(item)}
                  aria-label={`${p.t("templatePreview")} ${item.title}`}
                >
                  <div className={css.templateCover}>
                    <TemplateImage item={item} eager={index < 4} />
                  </div>
                  <div className={css.templateCardInfo}>
                    <strong>{item.title}</strong>
                    <span>{sourceName(item)}</span>
                  </div>
                </button>
                <Tooltip
                  label={p.t(
                    result?.favorites.includes(item.id)
                      ? "templateUnfavorite"
                      : "templateFavorite",
                  )}
                >
                  <Button
                    className={css.templateFavorite}
                    size="sm"
                    aria-label={p.t(
                      result?.favorites.includes(item.id)
                        ? "templateUnfavorite"
                        : "templateFavorite",
                    )}
                    aria-pressed={result?.favorites.includes(item.id) ?? false}
                    disabled={favoriteBusy.includes(item.id)}
                    onClick={() => void favorite(item)}
                  >
                    <Icon name="star" size={18} />
                  </Button>
                </Tooltip>
              </article>
            ))}
            {busy &&
              (!items.length || offset > 0) &&
              Array.from({ length: items.length ? 4 : 8 }, (_, i) => (
                <div
                  key={`skeleton-${i}`}
                  className={css.templateSkeleton}
                  aria-hidden
                >
                  <div />
                  <i />
                  <i />
                </div>
              ))}
          </div>
          {!busy && !error && !items.length && (
            <div className={css.templateEmpty}>
              <div className={css.templateEmptyArt}>
                <Icon name={favoritesOnly ? "star" : "search"} size={32} />
              </div>
              <h2>
                {p.t(
                  favoritesOnly && !query && !category && !source && !model
                    ? "templateNoFavorites"
                    : "templateNoResults",
                )}
              </h2>
              <p>
                {p.t(
                  favoritesOnly
                    ? "templateFavoriteHint"
                    : "templateNoResultsHint",
                )}
              </p>
              <Button onClick={reset}>{p.t("templateExplore")}</Button>
            </div>
          )}
          {!!items.length && (
            <div className={css.templateBottom}>
              {result && items.length < result.total && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setOffset(items.length)}
                >
                  {p.t("templateLoadMore")}
                </Button>
              )}
              <small>{p.t("templateAttribution")}</small>
            </div>
          )}
        </>
      )}
      <Modal
        open={!!detail}
        onClose={() => !using && setDetail(undefined)}
        title={detail?.title ?? p.t("templatePreview")}
        closeLabel={p.t("close")}
        className={css.templateDetailDialog}
        contentClassName={css.templateDetailContent}
        footer={
          detail && (
            <>
              <Button
                disabled={using || favoriteBusy.includes(detail.id)}
                onClick={() => void favorite(detail)}
                aria-pressed={result?.favorites.includes(detail.id) ?? false}
              >
                <Icon name="star" size={17} />
                {p.t(
                  result?.favorites.includes(detail.id)
                    ? "templateUnfavorite"
                    : "templateFavorite",
                )}
              </Button>
              <span className={css.dialogFooterSpacer} />
              <Button
                variant="primary"
                disabled={using}
                onClick={() => void use(detail)}
              >
                <Icon name="plus" size={17} />
                {p.t(
                  using
                    ? referenceUrls.length
                      ? "templatePreparingImages"
                      : "templateApplying"
                    : "templateUse",
                )}
              </Button>
            </>
          )
        }
      >
        {detail && (
          <div className={css.templateDetail}>
            <div className={css.templateDetailVisual}>
              <div className={css.templateDetailCover}>
                <TemplateImage key={detail.id} item={detail} eager />
              </div>
              {!!referenceChoices.length && (
                <div className={css.templateReferences}>
                  <strong>{p.t("templateReferences")}</strong>
                  <div className={css.templateReferenceStrip}>
                    {referenceChoices.map((url, index) => (
                      <button
                        key={url}
                        aria-pressed={referenceUrls.includes(url)}
                        disabled={using}
                        onClick={() =>
                          setReferenceUrls((old) =>
                            old.includes(url)
                              ? old.filter((item) => item !== url)
                              : [...old, url],
                          )
                        }
                      >
                        <span className={css.templateReferenceImage}>
                          <TemplateImage
                            key={url}
                            item={{ ...detail, coverUrl: url }}
                          />
                          <i>
                            <Icon
                              name={
                                referenceUrls.includes(url) ? "check" : "plus"
                              }
                              size={13}
                            />
                          </i>
                        </span>
                        <span>
                          {url === detail.coverUrl
                            ? p.t("templateUseCover")
                            : `${p.t("templateReference")} ${index + 1}`}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p>
                    {p.t(
                      referenceUrls.length
                        ? "templateReferencesHint"
                        : "templateNoReferencesHint",
                    )}
                  </p>
                </div>
              )}
            </div>
            <div className={css.templateDetailBody}>
              <div className={css.templateCredit}>
                <a
                  href={detail.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {sourceName(detail)}
                  <Icon name="arrow" size={14} />
                </a>
                {detail.author && <span>{detail.author}</span>}
              </div>
              {(detail.imageModel || detail.imageMode === "edit") && (
                <div className={css.templateBadges}>
                  {detail.imageModel && (
                    <span>
                      {p.t("templateExampleModel")} · {detail.imageModel}
                    </span>
                  )}
                  {detail.imageMode === "edit" && (
                    <span>{p.t("templateImageEdit")}</span>
                  )}
                </div>
              )}
              {detail.description && (
                <p className={css.templateDescription}>{detail.description}</p>
              )}
              <div className={css.templatePromptHeading}>
                <strong>{p.t("templatePrompt")}</strong>
                <Button
                  size="sm"
                  aria-label={p.t("templateCopy")}
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(detail.prompt)
                      .then(() => p.notify(p.t("templateCopied")))
                      .catch(() => p.notify(p.t("templateCopyFailed")))
                  }
                >
                  <Icon name="copy" size={16} />
                </Button>
              </div>
              <pre className={css.templatePrompt}>{detail.prompt}</pre>
              <div className={css.templateBadges}>
                {detail.tags.slice(0, 8).map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
              <p className={css.templateUseHint}>
                {p.t(
                  referenceUrls.length
                    ? "templateUseWithReferences"
                    : "templateUseHint",
                )}
              </p>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}

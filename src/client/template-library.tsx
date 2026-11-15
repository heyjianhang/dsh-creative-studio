import { useEffect, useId, useRef, useState } from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Shared } from "./props.ts";
import type { CanvasTemplateSummary } from "../shared/contracts.ts";
import { ProjectCard, ProjectCardMenu } from "./project-card.tsx";
import {
  templateCategories,
  type PromptTemplate,
  type TemplateCategory,
  type TemplateResult,
} from "../shared/template-contracts.ts";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";
import ui from "./collection.module.css";
import {
  CollectionSelect,
  CollectionFilterButton,
  CollectionFilterDrawer,
  CollectionSearch,
  CollectionTypes,
  CollectionCard,
} from "./collection-ui.tsx";
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

export function TemplateLibrary({
  p,
  onUse,
  onUseCanvas,
  management = false,
}: {
  p: Shared;
  management?: boolean;
  onUse(item: PromptTemplate, referenceUrls: string[]): Promise<void>;
  onUseCanvas(id: string): Promise<void>;
}) {
  const typesId = useId();
  const [type, setType] = useState<"image" | "video" | "canvas">("image");
  const [canvasCount, setCanvasCount] = useState<number>();
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState<TemplateCategory>(),
    [source, setSource] = useState(""),
    [model, setModel] = useState("");
  const [result, setResult] = useState<TemplateResult>(),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(false);
  const [detail, setDetail] = useState<PromptTemplate>(),
    [using, setUsing] = useState(false);
  const [referenceUrls, setReferenceUrls] = useState<string[]>([]);
  const refreshRequested = useRef(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [items, setItems] = useState<PromptTemplate[]>([]);
  const criteria = JSON.stringify({
    query,
    category,
    source,
    model,
  });
  const previousCriteria = useRef(criteria);
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
              offset: changed ? 0 : offset,
              limit: 48,
              refresh,
            },
            abort.signal,
          )
          .then((data) => {
            if (abort.signal.aborted) return;
            setResult(data);
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
    setOffset(0);
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
  const sourceName = (item: PromptTemplate) =>
    result?.sources.find((s) => s.id === item.sourceId)?.name ?? item.sourceId;
  return (
    <section
      className={css.templateLibrary}
      data-management={management || undefined}
      aria-label={p.t("templates")}
    >
      {filterOpen && type === "image" && (
        <CollectionFilterDrawer
          title={p.t("collectionFilter")}
          summary={`${result?.total ?? items.length} ${p.t("templateCount")}`}
          closeLabel={p.t("close")}
          resetLabel={p.t("reset")}
          doneLabel={p.t("done")}
          active={!!(category || source || model)}
          onClose={() => setFilterOpen(false)}
          onReset={() => {
            setCategory(undefined);
            setSource("");
            setModel("");
            setOffset(0);
          }}
        >
          <section className={ui.filterSection}>
            <h3>{p.t("templatePurpose")}</h3>
            <div className={ui.filterOptions}>
              <Button
                aria-pressed={!category}
                onClick={() => setCategory(undefined)}
              >
                {p.t("all")}
              </Button>
              {templateCategories.map((id) => (
                <Button
                  key={id}
                  aria-pressed={category === id}
                  onClick={() => setCategory(id)}
                >
                  {p.t(`templateCategory_${id}`)}
                </Button>
              ))}
            </div>
          </section>
          <section className={ui.filterSection}>
            <h3>{p.t("templateAllSources")}</h3>
            <CollectionSelect
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
          </section>
          <section className={ui.filterSection}>
            <h3>{p.t("templateAllModels")}</h3>
            <CollectionSelect
              label={p.t("templateAllModels")}
              value={model}
              onChange={setModel}
              options={[
                { id: "", label: p.t("templateAllModels") },
                ...(result?.models ?? []).map((m) => ({ id: m, label: m })),
              ]}
            />
          </section>
        </CollectionFilterDrawer>
      )}
      <div className={ui.templateMain}>
        <div className={ui.toolbar}>
          <CollectionSearch
            ref={searchInput}
            aria-label={p.t(
              type === "canvas" ? "canvasTemplateSearch" : "templateSearch",
            )}
            placeholder={p.t(
              type === "canvas" ? "canvasTemplateSearch" : "templateSearch",
            )}
            value={query}
            disabled={type === "video"}
            onChange={(e) => setQuery(e.target.value)}
            clearLabel={p.t("clearSearch")}
            onClear={() => setQuery("")}
          />
          <CollectionTypes<"image" | "video" | "canvas">
            id={typesId}
            value={type}
            onChange={setType}
            label={p.t("templateType")}
            options={(["image", "video", "canvas"] as const).map((value) => ({
              value,
              label: p.t(value === "canvas" ? "templateCanvas" : value),
            }))}
          />
          <div className={ui.resultTools}>
            <span className={ui.srOnly} role="status">
              {type === "canvas"
                ? (canvasCount ?? 0)
                : type === "image"
                  ? (result?.total ?? items.length)
                  : 0}{" "}
              {p.t("templateCount")}
            </span>
            {type === "image" && (
              <>
                <CollectionFilterButton
                  label={p.t("collectionFilter")}
                  open={filterOpen}
                  count={
                    Number(!!category) + Number(!!source) + Number(!!model)
                  }
                  onClick={() => setFilterOpen(!filterOpen)}
                />
                <ProjectCardMenu
                  disabled={busy}
                  label={p.t("more")}
                  items={[{ id: "refresh", label: p.t("templateRefresh") }]}
                  onSelect={() => {
                    refreshRequested.current = true;
                    setOffset(0);
                    setRevision((v) => v + 1);
                  }}
                />
              </>
            )}
          </div>
        </div>
        <div
          role="tabpanel"
          id={`${typesId}-${type}-panel`}
          aria-labelledby={`${typesId}-${type}`}
        >
          {type === "canvas" ? (
            <CanvasTemplateList
              p={p}
              query={query}
              management={management}
              onUse={onUseCanvas}
              onCount={setCanvasCount}
              focusSearch={() => searchInput.current?.focus()}
            />
          ) : type === "video" ? (
            <div className={ui.empty}>
              <div className={css.templateEmptyArt}>
                <Icon name="video" size={38} />
              </div>
              <h2>{p.t("templateVideoSoon")}</h2>
              <p>{p.t("templateVideoSoonHint")}</p>
              <Button onClick={() => setType("image")}>
                {p.t("templateBrowseImages")}
                <Icon name="arrow" size={16} />
              </Button>
            </div>
          ) : (
            <>
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
                    {p.t(
                      result ? "templateRefreshFailed" : "templateLoadFailed",
                    )}
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
              <div className={ui.grid} aria-busy={busy}>
                {items.map((item, index) => (
                  <CollectionCard
                    key={item.id}
                    title={item.title}
                    subtitle={sourceName(item)}
                    cover={<TemplateImage item={item} eager={index < 4} />}
                    onOpen={() => openDetail(item)}
                    openLabel={`${p.t("templatePreview")} ${item.title}`}
                  />
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
                <div className={ui.empty}>
                  <div className={css.templateEmptyArt}>
                    <Icon name="search" size={32} />
                  </div>
                  <h2>{p.t("templateNoResults")}</h2>
                  <p>{p.t("templateNoResultsHint")}</p>
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
        </div>
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
                  <p className={css.templateDescription}>
                    {detail.description}
                  </p>
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
      </div>
    </section>
  );
}

function CanvasTemplateList({
  p,
  query,
  management,
  onUse,
  onCount,
  focusSearch,
}: {
  p: Shared;
  query: string;
  management: boolean;
  onUse(id: string): Promise<void>;
  onCount(count?: number): void;
  focusSearch(): void;
}) {
  const [templates, setTemplates] = useState<CanvasTemplateSummary[]>();
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [using, setUsing] = useState<string>();
  const [useError, setUseError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<CanvasTemplateSummary>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setLoadError(false);
    void p.request("canvasTemplates", {}, abort.signal).then(
      (items) => {
        if (!abort.signal.aborted) setTemplates(items);
      },
      () => {
        if (!abort.signal.aborted) setLoadError(true);
      },
    );
    return () => abort.abort();
  }, [attempt, p.request]);
  const items = templates?.filter((item) =>
    item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const count = items?.length;
  useEffect(() => {
    onCount(loadError ? undefined : count);
    return () => onCount(undefined);
  }, [count, loadError, onCount]);
  const apply = async (id: string) => {
    if (using) return;
    setUsing(id);
    setUseError("");
    try {
      await onUse(id);
    } catch (error) {
      setUseError(error instanceof Error ? error.message : String(error));
    } finally {
      setUsing(undefined);
    }
  };
  const remove = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await p.request("removeCanvasTemplate", { id: deleteTarget.id });
      setTemplates((previous) =>
        previous?.filter((item) => item.id !== deleteTarget.id),
      );
      setDeleteTarget(undefined);
      requestAnimationFrame(focusSearch);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };
  if (loadError)
    return (
      <div className={css.templateError} role="alert">
        {p.t("canvasTemplateLoadFailed")}
        <Button size="sm" onClick={() => setAttempt((v) => v + 1)}>
          {p.t("retry")}
        </Button>
      </div>
    );
  if (!items) return <p role="status">{p.t("templateLoading")}</p>;
  if (!items.length)
    return (
      <div className={ui.empty}>
        <div className={css.templateEmptyArt}>
          <Icon name="grid" size={38} />
        </div>
        <h2>
          {p.t(
            templates?.length ? "templateNoResults" : "canvasTemplatesEmpty",
          )}
        </h2>
        <p>
          {p.t(
            templates?.length
              ? "templateNoResultsHint"
              : "canvasTemplatesEmptyHint",
          )}
        </p>
      </div>
    );
  return (
    <>
      {useError && (
        <p className={css.templateError} role="alert">
          {useError}
        </p>
      )}
      <div className={ui.grid}>
        {items.map((item) => (
          <ProjectCard
            key={item.id}
            p={p}
            name={item.name}
            date={item.createdAt}
            count={item.nodeCount}
            cover={item.cover}
            owner={{ templateId: item.id }}
            disabled={!!using}
            openLabel={`${item.name} · ${p.t(using === item.id ? "templateApplying" : management ? "canvasTemplateCreate" : "canvasTemplateInsert")}`}
            onOpen={() => void apply(item.id)}
            actions={
              management && (
                <ProjectCardMenu
                  label={`${item.name} · ${p.t("more")}`}
                  disabled={!!using}
                  items={[
                    {
                      id: "delete",
                      label: p.t("canvasTemplateDelete"),
                      icon: <Icon name="trash" size={16} />,
                      danger: true,
                    },
                  ]}
                  onSelect={() => {
                    setDeleteError("");
                    setDeleteTarget(item);
                  }}
                />
              )
            }
          />
        ))}
      </div>
      {deleteTarget && (
        <Modal
          open
          title={p.t("canvasTemplateDelete")}
          closeLabel={p.t("close")}
          onClose={() => !deleting && setDeleteTarget(undefined)}
          footer={
            <>
              <Button
                data-modal-autofocus
                disabled={deleting}
                onClick={() => setDeleteTarget(undefined)}
              >
                {p.t("cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={deleting}
                onClick={() => void remove()}
              >
                {p.t(
                  deleting ? "canvasTemplateDeleting" : "canvasTemplateDelete",
                )}
              </Button>
            </>
          }
        >
          <p>
            <strong>{deleteTarget.name}</strong>
          </p>
          <p>{p.t("canvasTemplateDeleteHint")}</p>
          {deleteError && (
            <p className={css.error} role="alert">
              {deleteError}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}

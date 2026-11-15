import { useEffect, useId, useRef, useState } from "react";
import {
  Button,
  Input,
  Modal,
  Tooltip,
  SegmentedControl,
  Checkbox,
} from "@deepseek-ai/dsh-client-ui-primitives";
import {
  modelFromDiscovery,
  modelKind,
  type DiscoveredModel,
  type EmbeddingModel,
  type MediaModel,
  type ModelDiscovery,
} from "../shared/media-contracts.ts";
import type { Shared } from "./props.ts";
import { Choice } from "./media-controls.tsx";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";

const supported = (model: DiscoveredModel) =>
  model.kind === "embedding" || !!model.capabilities;

export function MediaModelPicker({
  p,
  mode,
  added,
  onAdd,
  onClose,
  replacing,
  allowEmbedding,
}: {
  p: Shared;
  mode: "native" | "plan";
  added: readonly { model: string }[];
  onAdd(models: MediaModel[], embeddings: EmbeddingModel[]): Promise<void>;
  onClose(): void;
  replacing?: MediaModel;
  allowEmbedding: boolean;
}) {
  const [data, setData] = useState<ModelDiscovery>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState("all"),
    [selected, setSelected] = useState<string[]>([]),
    [manual, setManual] = useState(false),
    [modelId, setModelId] = useState(""),
    [base, setBase] = useState(""),
    [submitting, setSubmitting] = useState(false);
  const controller = useRef<AbortController>();
  const tabsId = useId();
  const load = async (refresh: boolean) => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setLoading(true);
    setError("");
    try {
      const next = await p.request(
        "discoverMediaModels",
        { mode, refresh },
        c.signal,
      );
      if (c.signal.aborted) return;
      setData(next);
      setSelected((ids) =>
        ids.filter((id) =>
          next.models.some((m) => m.model === id && supported(m)),
        ),
      );
    } catch (e) {
      if (!c.signal.aborted) setError((e as Error).message);
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
  };
  useEffect(() => {
    void load(false);
    return () => controller.current?.abort();
  }, [mode, p.request]);
  const existing = new Set(added.map((m) => m.model));
  const available = (data?.models ?? []).filter((m) =>
    replacing
      ? m.kind === modelKind(replacing)
      : allowEmbedding || m.kind !== "embedding",
  );
  const models = available
    .filter(
      (m) =>
        (kind === "all" || m.kind === kind) &&
        `${m.name} ${m.model}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(a.retiring) - Number(b.retiring) ||
        Number(!supported(a)) - Number(!supported(b)),
    );
  const candidates = available.filter(supported);
  const baseItem = candidates.find((m) => m.model === base);
  const validId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,199}$/.test(modelId.trim());
  const count = selected.filter((id) => !existing.has(id)).length;
  const add = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      if (manual && (!baseItem || !validId || existing.has(modelId.trim())))
        return;
      const chosen =
        manual && baseItem
          ? [baseItem]
          : candidates.filter(
              (m) => selected.includes(m.model) && !existing.has(m.model),
            );
      const generation: MediaModel[] = [];
      const embeddings: EmbeddingModel[] = [];
      for (const item of chosen) {
        const model = manual ? modelId.trim() : item.model;
        const name = manual ? model.slice(0, 120) : item.name;
        if (item.kind === "embedding") {
          embeddings.push({
            id: crypto.randomUUID(),
            model,
            name,
            enabled: true,
          });
        } else {
          generation.push({ ...modelFromDiscovery(item), model, name });
        }
      }
      await onAdd(generation, embeddings);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Modal
      open
      title={p.t(replacing ? "reselectModel" : "addMediaModels")}
      closeLabel={p.t("close")}
      className={css.modelDiscoveryDialog}
      contentClassName={css.providerContent}
      onClose={() => {
        if (!submitting) onClose();
      }}
      footer={
        <>
          <Button size="sm" disabled={submitting} onClick={onClose}>
            {p.t("cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={
              loading ||
              submitting ||
              (manual
                ? !baseItem || !validId || existing.has(modelId.trim())
                : !count)
            }
            onClick={() => void add()}
          >
            {replacing
              ? p.t("save")
              : manual
                ? p.t("addMediaModels")
                : `${p.t("addSelectedModels")} (${count})`}
          </Button>
        </>
      }
    >
      <div className={css.modelDiscoveryBody}>
        <div className={css.discoveryToolbar}>
          <Input
            className={css.discoverySearch}
            icon={<Icon name="search" size={18} />}
            data-modal-autofocus
            value={query}
            placeholder={p.t("searchMediaModels")}
            aria-label={p.t("searchMediaModels")}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Tooltip label={p.t("refreshModels")}>
            <Button
              aria-label={p.t("refreshModels")}
              disabled={loading}
              onClick={() => void load(true)}
            >
              <Icon name="refresh" size={18} />
            </Button>
          </Tooltip>
        </div>
        <div className={css.discoveryTabs}>
          <SegmentedControl
            id={tabsId}
            label={p.t("mediaModels")}
            value={kind}
            options={(allowEmbedding && !replacing
              ? (["all", "image", "video", "embedding"] as const)
              : (["all", "image", "video"] as const)
            ).map((value) => ({
              value,
              label: p.t(value),
            }))}
            onChange={setKind}
          />
          <span>{mode === "plan" ? "Agent Plan" : p.t("volcNative")}</span>
        </div>
        {error && (
          <div className={css.discoveryNotice} role="alert">
            {error}{" "}
            <Button size="sm" onClick={() => void load(true)}>
              {p.t("retry")}
            </Button>
          </div>
        )}
        {data?.warning && (
          <div className={css.discoveryNotice} role="status">
            {p.t("catalogRefreshFailed")}
          </div>
        )}
        <div
          className={css.discoveryList}
          aria-busy={loading || submitting}
          role="tabpanel"
          id={`${tabsId}-${kind}-panel`}
          aria-labelledby={`${tabsId}-${kind}`}
        >
          {loading && !data
            ? Array.from({ length: 4 }, (_, i) => (
                <div className={css.discoverySkeleton} key={i} />
              ))
            : models.map((m) => {
                const disabled =
                  existing.has(m.model) || !supported(m) || submitting;
                return (
                  <div
                    key={m.model}
                    className={css.discoveryRow}
                    data-disabled={disabled || loading}
                    data-selected={selected.includes(m.model)}
                    onClick={(event) => {
                      if (
                        disabled ||
                        loading ||
                        (event.target as HTMLElement).closest("label")
                      )
                        return;
                      setSelected((old) =>
                        old.includes(m.model)
                          ? old.filter((id) => id !== m.model)
                          : replacing
                            ? [m.model]
                            : [...old, m.model],
                      );
                    }}
                  >
                    <div className={css.discoveryModelText}>
                      <Checkbox
                        label={m.name}
                        checked={
                          selected.includes(m.model) || existing.has(m.model)
                        }
                        disabled={disabled || loading}
                        onChange={(checked) =>
                          setSelected((old) =>
                            checked
                              ? replacing
                                ? [m.model]
                                : [...old, m.model]
                              : old.filter((id) => id !== m.model),
                          )
                        }
                      />
                      <small title={m.model}>{m.model}</small>
                      <small>
                        {m.retiring
                          ? p.t("modelRetiring")
                          : m.kind === "embedding"
                            ? p.t("embeddingUse")
                            : m.capabilities
                              ? `${m.capabilities.resolutions.join(" · ")}${m.kind === "video" ? ` · ${m.capabilities.durations[0]}–${m.capabilities.durations.at(-1)}s` : ""}`
                              : p.t("modelUnadapted")}
                      </small>
                    </div>
                    <span className={css.discoveryType}>
                      <Icon name={m.kind} size={15} />
                      {p.t(m.kind)}
                    </span>
                    {existing.has(m.model) && (
                      <small>{p.t("modelAdded")}</small>
                    )}
                  </div>
                );
              })}
          {!loading && data && !models.length && (
            <div className={css.discoveryEmpty}>
              <Icon name="search" size={24} />
              {p.t("noMatchingModels")}
            </div>
          )}
        </div>
        {data && (
          <div className={css.discoverySource}>
            <Tooltip label={p.t("officialCatalogHint")}>
              <span>
                {p.t(
                  data.source === "official"
                    ? "officialCatalog"
                    : data.source === "cache"
                      ? "cachedCatalog"
                      : "bundledCatalog",
                )}
              </span>
            </Tooltip>
            <time dateTime={data.fetchedAt}>
              {new Date(data.fetchedAt).toLocaleString()}
            </time>
          </div>
        )}
        <div className={css.manualModel}>
          <Button
            size="sm"
            aria-expanded={manual}
            onClick={() => {
              setManual(!manual);
              setSelected([]);
            }}
          >
            <Icon name="plus" size={15} />
            {p.t("manualModel")}
          </Button>
          {manual && (
            <div className={css.manualModelFields}>
              <label className={css.settingsField}>
                {p.t("modelId")}
                <Input
                  value={modelId}
                  placeholder="ep-… / model-id"
                  maxLength={200}
                  onChange={(e) => setModelId(e.target.value)}
                />
              </label>
              <label className={css.settingsField}>
                {p.t("parameterSourceModel")}
                <Choice
                  value={base}
                  options={candidates.map((m) => ({
                    id: m.model,
                    label: m.name,
                  }))}
                  label={p.t("parameterSourceModel")}
                  onChange={setBase}
                />
              </label>
              {existing.has(modelId.trim()) && (
                <small role="alert">{p.t("modelAlreadyAdded")}</small>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  Button,
  Input,
  Modal,
  IconChevronRightOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import {
  mediaProviders,
  type MediaProviderId,
  validateProviderRoute,
} from "../shared/media-providers.ts";
import type { Shared } from "./props.ts";
import {
  capabilities,
  modelKind,
  normalizeParameters,
  type MediaSettingsInput,
  type MediaModel,
  type MediaParameters,
} from "../shared/media-contracts.ts";
import { Choice, Toggle } from "./media-controls.tsx";
import { MediaModelPicker } from "./media-model-picker.tsx";
import { Icon } from "./icons.tsx";
import { ProviderIcon } from "./provider-icon.tsx";
import css from "./studio.module.css";
type Connection = MediaSettingsInput["connections"][number] & {
  hasKey?: boolean;
};
type Draft = Omit<MediaSettingsInput, "connections"> & {
  connections: Connection[];
};
const newConnection = (mode: MediaProviderId): Connection => ({
  id: crypto.randomUUID(),
  name: "",
  mode,
  baseUrl: mediaProviders[mode].baseUrl,
  enabled: true,
  models: [],
});

export function MediaSettings(p: Shared & { initialConnection?: string }) {
  const [config, setConfig] = useState<Draft>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loadAttempt, setLoadAttempt] = useState(0),
    [dirty, setDirty] = useState(false),
    [open, setOpen] = useState<string>(),
    [editConnection, setEditConnection] = useState<Connection>(),
    [picker, setPicker] = useState<string>(),
    [replacing, setReplacing] = useState<string>(),
    [editingModel, setEditingModel] = useState<string>(),
    [modelError, setModelError] = useState(""),
    [refreshing, setRefreshing] = useState<string>();
  const alive = useRef(true),
    saving = useRef(false),
    refreshController = useRef<AbortController>();
  useEffect(() => {
    alive.current = true;
    const c = new AbortController();
    setError("");
    void p
      .request("mediaSettings", {}, c.signal)
      .then((value) => {
        if (!c.signal.aborted) {
          setConfig(value);
          if (p.initialConnection) setOpen(p.initialConnection);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => {
      alive.current = false;
      c.abort();
      refreshController.current?.abort();
    };
  }, [p.request, loadAttempt]);
  const update = (next: Draft) => {
    for (const kind of ["image", "video"] as const) {
      const key = kind === "image" ? "defaultImage" : "defaultVideo";
      const enabled = next.connections
        .filter((c) => c.enabled)
        .flatMap((c) => c.models)
        .filter((m) => m.enabled && modelKind(m) === kind);
      if (!enabled.some((m) => m.id === next[key])) next[key] = enabled[0]?.id;
    }
    setConfig(next);
    setDirty(true);
    setError("");
  };
  const connection = (id: string, patch: Partial<Connection>) => {
    if (config)
      update({
        ...config,
        connections: config.connections.map((c) =>
          c.id === id ? { ...c, ...patch } : c,
        ),
      });
  };
  const changeModel = (
    c: Connection,
    m: MediaModel,
    patch: Partial<MediaModel>,
  ) =>
    connection(c.id, {
      models: c.models.map((v) => (v.id === m.id ? { ...m, ...patch } : v)),
    });
  const persist = async (next: Draft) => {
    if (saving.current) throw new Error(p.t("saving"));
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await p.request("saveMediaSettings", next);
      if (!alive.current) return;
      setConfig(result);
      setDirty(false);
      p.notify(p.t("mediaConfigSaved"));
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const save = async () => {
    if (!config || busy) return;
    try {
      await persist(config);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  };
  const refreshModel = async (c: Connection, m: MediaModel) => {
    if (refreshing) return;
    const controller = new AbortController();
    refreshController.current = controller;
    setRefreshing(m.id);
    setModelError("");
    try {
      const data = await p.request(
        "discoverMediaModels",
        { mode: c.mode, refresh: true },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (data.warning) throw new Error(p.t("catalogRefreshFailed"));
      const found = data.models.find(
        (v) => v.model === (m.capabilityModel ?? m.model),
      );
      if (!found?.capabilities || found.kind !== modelKind(m))
        throw new Error(p.t("modelParametersMissing"));
      const next = {
        ...m,
        capabilities: found.capabilities,
        capabilityModel: found.model,
      };
      changeModel(c, m, { ...next, defaults: normalizeParameters(next) });
      p.notify(p.t("modelParametersUpdated"));
    } catch (e) {
      if (!controller.signal.aborted) setModelError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setRefreshing(undefined);
    }
  };
  const openModel = (id: string) => {
    setModelError("");
    setEditingModel(id);
  };
  const selectedConnection = config?.connections.find((c) => c.id === picker);
  const modelConnection = config?.connections.find((c) =>
    c.models.some((m) => m.id === editingModel),
  );
  const model = modelConnection?.models.find((m) => m.id === editingModel);
  return (
    <div className={`${css.settings} ${css.mediaSettingsPage}`}>
      <div className={css.mediaPageHeading}>
        <h1>{p.t("mediaConnections")}</h1>
      </div>
      <fieldset
        className={css.mediaSettingsFields}
        disabled={busy || !!refreshing}
      >
        {config?.connections.map((c) => (
          <article
            className={css.connectionCard}
            key={c.id}
            data-disabled={!c.enabled}
          >
            <header className={css.connectionHeader}>
              <Button
                className={css.connectionTitle}
                aria-expanded={open === c.id}
                onClick={() => setOpen(open === c.id ? undefined : c.id)}
              >
                <IconChevronRightOutlineRegular
                  size={16}
                  className={css.providerChevron}
                />
                <ProviderIcon size={22} />
                <span className={css.connectionIdentity}>
                  <strong>{c.name}</strong>
                  <small>
                    {c.mode === "plan" ? "Agent Plan" : p.t("volcNative")}
                    <span>·</span>
                    {c.models.length} {p.t("modelsCount")}
                  </small>
                </span>
              </Button>
              <Button
                size="sm"
                className={css.mediaIconAction}
                aria-label={p.t("editConnection")}
                title={p.t("editConnection")}
                onClick={() => setEditConnection({ ...c })}
              >
                <Icon name="edit" size={16} />
              </Button>
              <Toggle
                checked={c.enabled}
                onChange={(enabled) => connection(c.id, { enabled })}
                label={p.t("enableConnection")}
              />
            </header>
            {open === c.id && (
              <div className={css.connectionBody}>
                <div className={css.connectionMeta}>
                  <span className={css.connectionKeyStatus}>
                    <span
                      className={css.keyStatusDot}
                      data-ready={!!(c.apiKey || c.hasKey) && !c.clearKey}
                    />
                    {p.t(
                      (c.apiKey || c.hasKey) && !c.clearKey
                        ? "apiKeyConfigured"
                        : "apiKeyMissing",
                    )}
                  </span>
                  <Button size="sm" onClick={() => setPicker(c.id)}>
                    <Icon name="plus" size={14} />
                    {p.t("addMediaModels")}
                  </Button>
                </div>
                {c.models.length === 0 && (
                  <div className={css.modelsEmpty}>
                    <Icon name="image" size={22} />
                    <span>{p.t("noConfiguredModels")}</span>
                  </div>
                )}
                {(["image", "video"] as const).map((kind) => {
                  const models = c.models.filter((m) => modelKind(m) === kind);
                  return (
                    models.length > 0 && (
                      <div className={css.configModelGroup} key={kind}>
                        <h4>{p.t(kind)}</h4>
                        {models.map((m) => (
                          <div className={css.mediaModelConfig} key={m.id}>
                            <Button
                              className={css.modelConfigTitle}
                              aria-label={`${p.t("editModelSettings")} · ${m.name}`}
                              onClick={() => openModel(m.id)}
                            >
                              <span className={css.configModelIcon}>
                                <Icon name={kind} size={17} />
                              </span>
                              <span className={css.modelIdentity}>
                                <strong>{m.name}</strong>
                                <small title={m.model}>{m.model}</small>
                              </span>
                            </Button>
                            {config[
                              kind === "image" ? "defaultImage" : "defaultVideo"
                            ] === m.id && (
                              <small className={css.modelDefaultBadge}>
                                {p.t("defaultModel")}
                              </small>
                            )}
                            <Toggle
                              checked={m.enabled}
                              onChange={(enabled) =>
                                changeModel(c, m, { enabled })
                              }
                              label={`${p.t("enableModel")} · ${m.name}`}
                            />
                            <Button
                              size="sm"
                              className={css.mediaIconAction}
                              aria-label={`${p.t("editModelSettings")} · ${m.name}`}
                              title={p.t("editModelSettings")}
                              onClick={() => openModel(m.id)}
                            >
                              <Icon name="arrow" size={15} />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )
                  );
                })}
              </div>
            )}
          </article>
        ))}
      </fieldset>
      {!config && !error && (
        <div aria-label={p.t("loadingModels")} aria-busy="true">
          <div className={css.discoverySkeleton} />
        </div>
      )}

      {config && !config.connections.length && (
        <div className={css.mediaConfigEmpty}>
          <Icon name="sparkle" size={28} />
          <p>{p.t("mediaConfigEmpty")}</p>
        </div>
      )}
      <Button
        className={css.addProviderRow}
        disabled={
          !config || busy || !!refreshing || config.connections.length >= 20
        }
        onClick={() => setEditConnection(newConnection("native"))}
      >
        <Icon name="plus" size={16} />
        {p.t("addConnection")}
      </Button>
      {error && (
        <div className={css.discoveryNotice} role="alert">
          {error}
          {!config && (
            <Button size="sm" onClick={() => setLoadAttempt((v) => v + 1)}>
              {p.t("retry")}
            </Button>
          )}
        </div>
      )}
      {config && (
        <div className={css.mediaSettingsFooter}>
          <span role="status">
            {busy ? p.t("saving") : p.t(dirty ? "unsaved" : "saved")}
          </span>
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || busy || !!refreshing}
            onClick={() => void save()}
          >
            {p.t(busy ? "saving" : "save")}
          </Button>
        </div>
      )}
      {editConnection && (
        <ConnectionEditor
          p={p}
          value={editConnection}
          isNew={!config?.connections.some((c) => c.id === editConnection.id)}
          onClose={() => setEditConnection(undefined)}
          onRemove={() => {
            if (config)
              update({
                ...config,
                connections: config.connections.filter(
                  (c) => c.id !== editConnection.id,
                ),
              });
            setEditConnection(undefined);
          }}
          onSave={async (c, discover) => {
            if (!config) return;
            const exists = config.connections.some((v) => v.id === c.id);
            const next = {
              ...config,
              connections: exists
                ? config.connections.map((v) => (v.id === c.id ? c : v))
                : [...config.connections, c],
            };
            for (const kind of ["image", "video"] as const) {
              const key = kind === "image" ? "defaultImage" : "defaultVideo";
              const models = next.connections
                .filter((v) => v.enabled)
                .flatMap((v) => v.models)
                .filter((m) => m.enabled && modelKind(m) === kind);
              if (!models.some((m) => m.id === next[key]))
                next[key] = models[0]?.id;
            }
            await persist(next);
            if (!alive.current) return;
            setOpen(c.id);
            setEditConnection(undefined);
            if (discover) setPicker(c.id);
          }}
        />
      )}
      {modelConnection && model && config && (
        <ModelEditor
          p={p}
          c={modelConnection}
          m={model}
          isDefault={
            config[
              modelKind(model) === "image" ? "defaultImage" : "defaultVideo"
            ] === model.id
          }
          refreshing={refreshing}
          error={modelError}
          changeModel={changeModel}
          refreshModel={refreshModel}
          onReselect={() => {
            setReplacing(model.id);
            setPicker(modelConnection.id);
          }}
          onDefault={() =>
            update({
              ...config,
              [modelKind(model) === "image" ? "defaultImage" : "defaultVideo"]:
                model.id,
            })
          }
          onRemove={() => {
            connection(modelConnection.id, {
              models: modelConnection.models.filter((v) => v.id !== model.id),
            });
            setEditingModel(undefined);
          }}
          onClose={() => setEditingModel(undefined)}
        />
      )}
      {selectedConnection && (
        <MediaModelPicker
          p={p}
          mode={selectedConnection.mode}
          added={selectedConnection.models.filter((m) => m.id !== replacing)}
          replacing={selectedConnection.models.find((m) => m.id === replacing)}
          onClose={() => {
            setPicker(undefined);
            setReplacing(undefined);
          }}
          onAdd={async (models) => {
            if (!config || !models.length) return;
            const existing = new Set(
              selectedConnection.models.map((m) => m.model),
            );
            const previous = selectedConnection.models.find(
              (m) => m.id === replacing,
            );
            const nextModels = previous
              ? selectedConnection.models.map((m) =>
                  m.id === previous.id
                    ? {
                        ...models[0]!,
                        id: previous.id,
                        enabled: previous.enabled,
                        defaults: normalizeParameters(
                          models[0]!,
                          previous.defaults,
                        ),
                      }
                    : m,
                )
              : [
                  ...selectedConnection.models,
                  ...models.filter((m) => !existing.has(m.model)),
                ];
            await persist({
              ...config,
              connections: config.connections.map((c) =>
                c.id === selectedConnection.id
                  ? { ...c, models: nextModels }
                  : c,
              ),
              defaultImage:
                config.defaultImage ??
                nextModels.find((m) => modelKind(m) === "image" && m.enabled)
                  ?.id,
              defaultVideo:
                config.defaultVideo ??
                nextModels.find((m) => modelKind(m) === "video" && m.enabled)
                  ?.id,
            });
            setPicker(undefined);
            setReplacing(undefined);
          }}
        />
      )}
    </div>
  );
}

function ModelEditor({
  p,
  c,
  m,
  isDefault,
  refreshing,
  error,
  changeModel,
  refreshModel,
  onDefault,
  onRemove,
  onClose,
  onReselect,
}: {
  p: Shared;
  c: Connection;
  m: MediaModel;
  isDefault: boolean;
  refreshing?: string;
  error: string;
  changeModel(c: Connection, m: MediaModel, patch: Partial<MediaModel>): void;
  refreshModel(c: Connection, m: MediaModel): Promise<void>;
  onDefault(): void;
  onRemove(): void;
  onClose(): void;
  onReselect(): void;
}) {
  const kind = modelKind(m);
  return (
    <Modal
      open
      title={p.t("editModelSettings")}
      closeLabel={p.t("close")}
      className={css.modelEditorDialog}
      contentClassName={css.providerContent}
      onClose={onClose}
      footer={
        <>
          <span className={css.dialogFooterSpacer} />
          <Button
            variant="outline"
            size="sm"
            disabled={isDefault || !m.enabled || !c.enabled || !!refreshing}
            onClick={onDefault}
          >
            {p.t(isDefault ? "defaultModel" : "setDefault")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={css.mediaDangerAction}
            disabled={!!refreshing}
            onClick={onRemove}
          >
            {p.t("removeModel")}
          </Button>
          <Button variant="primary" size="sm" onClick={onClose}>
            {p.t("done")}
          </Button>
        </>
      }
    >
      <div className={css.modelEditorIdentity}>
        <span className={css.configModelIcon}>
          <Icon name={kind} size={20} />
        </span>
        <span>
          <strong>{m.name}</strong>
          <small>{m.model}</small>
          <Button size="sm" onClick={onReselect}>
            {p.t("reselectModel")}
          </Button>
        </span>
      </div>
      {error && (
        <div role="alert" className={css.discoveryNotice}>
          {error}
        </div>
      )}
      <fieldset className={css.modelConfigBody} disabled={!!refreshing}>
        <label className={css.settingsField}>
          {p.t("displayName")}
          <Input
            value={m.name}
            maxLength={120}
            onChange={(e) =>
              changeModel(c, m, {
                name: e.target.value,
              })
            }
          />
        </label>
        <ModelParameters
          p={p}
          model={m}
          onChange={(defaults) => changeModel(c, m, { defaults })}
        />
        <details className={css.modelAdvanced}>
          <summary>{p.t("modelCapabilityDetails")}</summary>
          <dl>
            <dt>{p.t("referenceImageLimit")}</dt>
            <dd>{capabilities(m).maxImages}</dd>
            <dt>{p.t("parameterUpdatedAt")}</dt>
            <dd>
              {m.capabilities
                ? new Date(m.capabilities.fetchedAt).toLocaleString()
                : p.t("legacyParameters")}
            </dd>
            {m.capabilityModel && m.capabilityModel !== m.model && (
              <>
                <dt>{p.t("parameterSourceModel")}</dt>
                <dd>{m.capabilityModel}</dd>
              </>
            )}
          </dl>
          {m.capabilities?.sources.map((url, i) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">
              {p.t("officialParameterDocs")} {i + 1} ↗
            </a>
          ))}
          <Button
            size="sm"
            disabled={!!refreshing}
            onClick={() => void refreshModel(c, m)}
          >
            <Icon name="refresh" size={14} />
            {p.t(
              refreshing === m.id ? "loadingModels" : "refreshModelParameters",
            )}
          </Button>
        </details>
      </fieldset>
    </Modal>
  );
}

function ConnectionEditor({
  p,
  value,
  isNew,
  onClose,
  onSave,
  onRemove,
}: {
  p: Shared;
  value: Connection;
  isNew: boolean;
  onClose(): void;
  onSave(c: Connection, discover: boolean): Promise<void>;
  onRemove(): void;
}) {
  const [draft, setDraft] = useState({ ...value }),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const providerDrafts = useRef<Partial<Record<MediaProviderId, Connection>>>(
    {},
  );
  const provider = mediaProviders[draft.mode];
  const selectProvider = (mode: string) => {
    if (mode === draft.mode || !(mode in mediaProviders)) return;
    const nextMode = mode as MediaProviderId;
    providerDrafts.current[draft.mode] = draft;
    setDraft(
      providerDrafts.current[nextMode] ??
        (isNew
          ? newConnection(nextMode)
          : {
              ...draft,
              mode: nextMode,
              baseUrl: mediaProviders[nextMode].baseUrl,
              models: [],
            }),
    );
    setError("");
  };
  const valid = !!(draft.apiKey?.trim() || draft.hasKey) && !draft.clearKey;
  const submit = async () => {
    if (saving) return;
    setError("");
    try {
      const url = new URL(draft.baseUrl);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(p.t("invalidApiUrl"));
      if (isNew && !valid) return;
      validateProviderRoute(draft.mode, draft.baseUrl);
      setSaving(true);
      await onSave(
        {
          ...draft,
          name: draft.name.trim() || p.t(provider.nameKey),
        },
        isNew || draft.mode !== value.mode,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      title={p.t(isNew ? "addProviderTitle" : "editConnection")}
      closeLabel={p.t("close")}
      onClose={() => {
        if (!saving) onClose();
      }}
      className={css.providerDialog}
      contentClassName={css.providerContent}
      footer={
        <>
          {!isNew && (
            <Button
              variant="outline"
              size="sm"
              className={css.mediaDangerAction}
              disabled={saving}
              onClick={onRemove}
            >
              <Icon name="trash" size={15} />
              {p.t("removeConnection")}
            </Button>
          )}
          <span className={css.dialogFooterSpacer} />
          <Button size="sm" disabled={saving} onClick={onClose}>
            {p.t("cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={saving || (isNew && !valid)}
            onClick={() => void submit()}
          >
            {p.t(saving ? "saving" : isNew ? "nextAddModels" : "save")}
          </Button>
        </>
      }
    >
      <fieldset className={css.providerEditor} disabled={saving}>
        <label className={css.settingsField}>
          {p.t("provider")}
          <Choice
            label={p.t("selectProvider")}
            value={draft.mode}
            side="bottom"
            stretch
            options={(["native", "plan"] as const).map((id) => ({
              id,
              label: p.t(mediaProviders[id].nameKey),
              icon: <ProviderIcon size={18} />,
            }))}
            onChange={selectProvider}
          />
        </label>
        {!isNew && draft.mode !== value.mode && (
          <div className={css.discoveryNotice} role="status">
            {p.t("providerChangedHint")}
          </div>
        )}
        <label className={css.settingsField}>
          {p.t("connectionName")}
          <Input
            data-modal-autofocus
            value={draft.name}
            maxLength={80}
            placeholder={p.t(provider.nameKey)}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <div className={css.providerCredentials}>
          <label className={css.settingsField}>
            API Key
            <Input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={draft.apiKey ?? ""}
              placeholder={p.t(
                draft.hasKey ? "keySavedPlaceholder" : provider.keyHint,
              )}
              onChange={(e) =>
                setDraft({ ...draft, apiKey: e.target.value, clearKey: false })
              }
            />
          </label>
          <label className={css.settingsField}>
            Base URL
            <Input
              value={draft.baseUrl}
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            />
          </label>
        </div>
        {error && (
          <div role="alert" className={css.error}>
            {error}
          </div>
        )}
      </fieldset>
    </Modal>
  );
}

function ModelParameters({
  p,
  model,
  onChange,
}: {
  p: Shared;
  model: MediaModel;
  onChange(value: MediaParameters): void;
}) {
  const cap = capabilities(model),
    params = model.defaults;
  const change = (patch: Partial<MediaParameters>) =>
    onChange(normalizeParameters(model, { ...params, ...patch }));
  return (
    <div className={css.modelDefaults}>
      <h4>{p.t("modelDefaults")}</h4>
      <div className={css.settingsGrid}>
        <label>
          {p.t("defaultRatio")}
          <Choice
            value={params.ratio}
            options={cap.ratios.map((id) => ({
              id,
              label: id === "adaptive" ? p.t("adaptive") : id,
            }))}
            onChange={(ratio) => change({ ratio })}
          />
        </label>
        <label>
          {p.t("resolution")}
          <Choice
            value={params.resolution}
            options={cap.resolutions.map((id) => ({ id, label: id }))}
            onChange={(resolution) => change({ resolution })}
          />
        </label>
        {cap.kind === "video" && (
          <>
            <label>
              {p.t("generateMode")}
              <Choice
                value={params.mode}
                options={cap.modes.map((id) => ({
                  id,
                  label: p.t(id === "frames" ? "modeFrames" : "modeReference"),
                }))}
                onChange={(mode) =>
                  change({ mode: mode as "frames" | "reference" })
                }
              />
            </label>
            <label>
              {p.t("duration")}
              <Choice
                value={String(params.duration)}
                options={cap.durations.map((id) => ({
                  id: String(id),
                  label: `${id}s`,
                }))}
                onChange={(id) => change({ duration: Number(id) })}
              />
            </label>
          </>
        )}
      </div>
      {cap.audio && (
        <div className={css.mediaSettingsHeading}>
          <span>{p.t("generateAudio")}</span>
          <Toggle
            checked={params.audio}
            onChange={(audio) => change({ audio })}
            label={p.t("generateAudio")}
          />
        </div>
      )}
    </div>
  );
}

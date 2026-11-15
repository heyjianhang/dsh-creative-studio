import { useState, useEffect, useRef } from "react";
import {
  Button,
  Input,
  Switch,
  SegmentedControl,
  Toast,
  IconFolderOpenOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { LibrarySettingsNavigation, SharedProps } from "./props.ts";
import type {
  LibraryPreferences,
  Input as RequestInput,
} from "../shared/contracts.ts";
import type { Key } from "./locales.ts";
import { TransferDialog, TransferList } from "./transfers.tsx";
import { ChoiceMenu } from "./choice-menu.tsx";
import css from "./library.module.css";

export function SettingsPage(p: SharedProps & LibrarySettingsNavigation) {
  const { data, error } = p.useCatalog((s) => s);
  return data ? (
    <SettingsForm {...p} initial={data.settings} />
  ) : error ? (
    <div role="alert" className={css.error}>
      {error}
      <Button size="sm" onClick={() => void p.refresh()}>
        {p.t("retry")}
      </Button>
    </div>
  ) : (
    <p role="status">{p.t("busy")}</p>
  );
}
function SettingsForm(
  p: SharedProps & LibrarySettingsNavigation & { initial: LibraryPreferences },
) {
  const data = p.useCatalog((s) => s.data);
  const [value, setValue] = useState(p.initial),
    [secret, setSecret] = useState({
      accessKeyId: "",
      secretAccessKey: "",
      sessionToken: "",
    });
  const [status, setStatus] = useState<Key>("saved"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [errorTarget, setErrorTarget] = useState<{
    kind: "model" | "s3";
    test: boolean;
  }>();
  const [transfer, setTransfer] = useState<{
    kind: "import" | "export";
    libraryId?: string;
  }>();
  const models = data?.embeddingModels ?? [];
  const selectedModelId = value.embeddingModelId;
  const selectedModel = models.find((m) => m.id === selectedModelId);
  const legacyModel = selectedModelId ? undefined : data?.legacyEmbeddingModel;
  const sequence = useRef(Promise.resolve()),
    revision = useRef(0),
    saved = useRef(JSON.stringify(p.initial));
  const pending = useRef<(() => void) | undefined>();
  const queue = (payload: RequestInput<"saveSettings">) => {
    const current = ++revision.current;
    setStatus("autoSaving");
    setError("");
    setErrorTarget(undefined);
    const next = sequence.current
      .catch(() => {})
      .then(async () => {
        await p.request("saveSettings", payload);
        saved.current = JSON.stringify(value);
        if (current === revision.current) setStatus("saved");
        await p.refresh();
      });
    sequence.current = next;
    void next.catch((e) => {
      if (current === revision.current) {
        setStatus("saveFailed");
        setError(e.message);
      }
    });
    return next;
  };
  pending.current = () => {
    if (JSON.stringify(value) !== saved.current)
      void queue(value).catch(() => {});
  };
  useEffect(() => () => pending.current?.(), []);
  useEffect(() => {
    if (JSON.stringify(value) === saved.current) return;
    setStatus("unsaved");
    const timer = setTimeout(() => {
      void queue(value).catch(() => {});
    }, 750);
    return () => clearTimeout(timer);
  }, [value]);
  const change = <K extends keyof LibraryPreferences>(
    key: K,
    next: LibraryPreferences[K],
  ) => setValue((v) => ({ ...v, [key]: next }));
  const input = (
    key:
      | "concurrency"
      | "maxRetries"
      | "segmentSeconds"
      | "ffmpegPath"
      | "ffprobePath",
    label: Key,
    type = "text",
    min?: number,
    max?: number,
  ) => (
    <label>
      {p.t(label)}
      <Input
        type={type}
        min={min}
        max={max}
        value={value[key]}
        onChange={(e) =>
          change(
            key,
            (type === "number"
              ? Number(e.target.value)
              : e.target.value) as never,
          )
        }
      />
    </label>
  );
  const s3input = (
    key: "endpoint" | "region" | "bucket" | "prefix",
    label: Key,
    placeholder?: string,
  ) => (
    <label>
      {p.t(label)}
      <Input
        value={value.s3[key]}
        placeholder={placeholder}
        onChange={(e) => change("s3", { ...value.s3, [key]: e.target.value })}
      />
    </label>
  );
  const credentials = (
    key: keyof typeof secret,
    label: Key,
    placeholder?: string,
  ) => (
    <label>
      {p.t(label)}
      <Input
        type="password"
        autoComplete="off"
        value={secret[key]}
        placeholder={placeholder}
        onChange={(e) => setSecret((s) => ({ ...s, [key]: e.target.value }))}
      />
    </label>
  );
  const connect = async (kind: "model" | "s3", test: boolean) => {
    setBusy(true);
    setNotice("");
    try {
      await queue({
        ...value,
        ...(kind === "s3"
          ? {
              accessKeyId: secret.accessKeyId || undefined,
              secretAccessKey: secret.secretAccessKey || undefined,
              sessionToken: secret.sessionToken || undefined,
            }
          : {}),
      });
      if (kind === "s3")
        setSecret({ accessKeyId: "", secretAccessKey: "", sessionToken: "" });
      if (test)
        await p.request(kind === "model" ? "testConnection" : "testS3", {});
      setNotice(p.t(test ? "connected" : "settingsSaved"));
    } catch (e) {
      setError((e as Error).message);
      setErrorTarget({ kind, test });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={css.settingsPage}>
      <header className={css.settingsHeading}>
        <div>
          <h2>{p.t("title")}</h2>
        </div>
        <span role="status" className={css.meta}>
          {p.t(status)}
        </span>
      </header>
      {error && (
        <div role="alert" className={css.error}>
          {error}
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              if (errorTarget) void connect(errorTarget.kind, errorTarget.test);
              else void queue(value).catch(() => {});
            }}
          >
            {p.t("retry")}
          </Button>
        </div>
      )}
      {notice && (
        <Toast text={notice} holdMs={3000} onDone={() => setNotice("")} />
      )}
      <section className={css.settingSection}>
        <h3>{p.t("aiIndexSettings")}</h3>
        <div className={css.settingCard}>
          {models.length ? (
            <div className={css.form}>
              <div className={css.embeddingModelField}>
                <span>{p.t("embeddingModel")}</span>
                <ChoiceMenu
                  label={p.t("embeddingModel")}
                  value={selectedModelId ?? ""}
                  placeholder={
                    legacyModel ??
                    p.t(
                      selectedModelId
                        ? "embeddingModelUnavailable"
                        : "selectEmbeddingModel",
                    )
                  }
                  options={models.map((m) => ({
                    id: m.id,
                    label: `${m.name} · ${m.connectionName}`,
                  }))}
                  disabled={busy}
                  onChange={(id) => change("embeddingModelId", id)}
                />
              </div>
              <p className={css.settingHint}>
                {p.t(
                  legacyModel
                    ? "switchLegacyEmbeddingModelHint"
                    : "changeEmbeddingModelHint",
                )}
              </p>
              <div className={css.settingActions}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !selectedModel}
                  onClick={() => void connect("model", true)}
                >
                  {p.t("testEmbeddingModel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className={css.settingRow}>
              <div className={css.settingRowText}>
                <span className={css.embeddingModelValue}>
                  {legacyModel ??
                    p.t(
                      selectedModelId
                        ? "embeddingModelUnavailable"
                        : "embeddingModelMissing",
                    )}
                </span>
                <p>
                  {p.t(
                    legacyModel
                      ? "legacyEmbeddingModelHint"
                      : "addEmbeddingModelHint",
                  )}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={p.openModelSettings}>
                {p.t("openModelSettings")}
              </Button>
            </div>
          )}
        </div>
      </section>
      <section className={css.settingSection}>
        <h3>{p.t("storageSettings")}</h3>
        <div className={css.settingCard}>
          <div className={css.settingRow}>
            <div className={css.settingRowText}>
              <span>{p.t("storageTitle")}</span>
              <p>{p.t("storageHelp")}</p>
            </div>
            <SegmentedControl
              id="asset-library-storage"
              label={p.t("storageTitle")}
              value={value.storageMode}
              disabled={busy}
              options={[
                { value: "local", label: p.t("localStorage") },
                { value: "s3", label: p.t("s3Storage") },
              ]}
              onChange={(mode) => change("storageMode", mode)}
            />
          </div>
          <div
            role="tabpanel"
            id={`asset-library-storage-${value.storageMode}-panel`}
            aria-labelledby={`asset-library-storage-${value.storageMode}`}
            className={css.settingBody}
          >
            {value.storageMode === "local" ? (
              <div className={css.form}>
                <label>
                  {p.t("localFolderLabel")}
                  <div className={css.folderField}>
                    <Input
                      value={value.localDirectory}
                      placeholder={p.t("localFolderPlaceholder")}
                      onChange={(e) => change("localDirectory", e.target.value)}
                    />
                    <Button
                      variant="outline"
                      onClick={() =>
                        void p
                          .pickDirectory()
                          .then((path) => {
                            if (path) change("localDirectory", path);
                          })
                          .catch((e) => setError(e.message))
                      }
                    >
                      {p.t("chooseFolder")}
                    </Button>
                  </div>
                </label>
              </div>
            ) : (
              <div className={css.form}>
                <div className={css.settingTitle}>
                  <span className={css.settingLabel}>
                    {p.t("s3Connection")}
                  </span>
                  <span
                    className={css.settingCredential}
                    data-configured={!!data?.s3Configured}
                  >
                    {p.t(data?.s3Configured ? "configured" : "notConfigured")}
                  </span>
                </div>
                {s3input("endpoint", "s3Endpoint", "https://s3.example.com")}
                <div className={css.settingRow}>
                  <div className={css.settingRowText}>
                    <span>{p.t("s3AllowHttp")}</span>
                    <p>{p.t("s3AllowHttpHelp")}</p>
                  </div>
                  <Switch
                    checked={value.s3.allowInsecureHttp}
                    onChange={(checked) =>
                      change("s3", { ...value.s3, allowInsecureHttp: checked })
                    }
                    label={p.t("s3AllowHttp")}
                  />
                </div>
                <div className={css.twoColumns}>
                  {s3input("bucket", "s3Bucket")}
                  {s3input("region", "s3Region", "us-east-1")}
                </div>
                {s3input("prefix", "s3Prefix")}
                <div className={css.settingRow}>
                  <div className={css.settingRowText}>
                    <span>{p.t("s3PathStyle")}</span>
                    <p>{p.t("s3PathHelp")}</p>
                  </div>
                  <Switch
                    checked={value.s3.forcePathStyle}
                    onChange={(checked) =>
                      change("s3", { ...value.s3, forcePathStyle: checked })
                    }
                    label={p.t("s3PathStyle")}
                  />
                </div>
                <div className={css.twoColumns}>
                  {credentials(
                    "accessKeyId",
                    "accessKeyId",
                    p.t(data?.s3Configured ? "keyRetain" : "accessKeyId"),
                  )}
                  {credentials(
                    "secretAccessKey",
                    "secretAccessKey",
                    p.t(data?.s3Configured ? "keyRetain" : "secretAccessKey"),
                  )}
                </div>
                <details className={css.settingDisclosure}>
                  <summary>{p.t("temporaryToken")}</summary>
                  <div className={css.settingDisclosureBody}>
                    {credentials("sessionToken", "sessionToken")}
                  </div>
                </details>
                <p className={css.settingHint}>{p.t("s3SecretHelp")}</p>
                <div className={css.settingActions}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      busy || !secret.accessKeyId || !secret.secretAccessKey
                    }
                    onClick={() => void connect("s3", false)}
                  >
                    {p.t("saveCredentials")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void connect("s3", true)}
                  >
                    {p.t("testS3")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
      <section className={css.settingSection}>
        <h3>{p.t("processingTitle")}</h3>
        <div className={css.settingCard}>
          <div className={css.form}>
            <div className={css.twoColumns}>
              {input("concurrency", "concurrency", "number", 1, 4)}
              {input("maxRetries", "retries", "number", 0, 5)}
            </div>
            {input("segmentSeconds", "segment", "number", 5, 60)}
            <details className={css.settingDisclosure}>
              <summary>{p.t("advancedTools")}</summary>
              <div className={`${css.form} ${css.settingDisclosureBody}`}>
                {input("ffmpegPath", "ffmpeg")}
                {input("ffprobePath", "ffprobe")}
              </div>
            </details>
          </div>
        </div>
      </section>
      <section className={css.settingSection}>
        <div className={css.settingTitle}>
          <h3>{p.t("libraryMigration")}</h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setTransfer({ kind: "import" })}
          >
            {p.t("importZip")}
          </Button>
        </div>
        {data?.libraries.length ? (
          <div className={css.settingCard}>
            {data.libraries.map((lib) => (
              <div key={lib.id} className={css.settingLibrary}>
                <IconFolderOpenOutlineRegular size={20} />
                <div>
                  <strong title={lib.name}>{lib.name}</strong>
                  <span>
                    {p.t(
                      lib.storage.mode === "s3" ? "s3Storage" : "localStorage",
                    )}{" "}
                    · {lib.count} {p.t("items")}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!lib.available}
                  onClick={() =>
                    setTransfer({ kind: "export", libraryId: lib.id })
                  }
                >
                  {p.t("exportZip")}
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className={css.settingHint}>{p.t("migrationEmpty")}</p>
        )}
        <TransferList {...p} />
      </section>
      {transfer && (
        <TransferDialog
          {...p}
          {...transfer}
          storageMode={value.storageMode}
          onClose={() => setTransfer(undefined)}
        />
      )}
    </div>
  );
}

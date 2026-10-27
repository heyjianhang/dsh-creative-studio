import { useEffect, useState } from "react";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { CreativeFolder } from "../shared/contracts.ts";
import type { CanvasProps } from "./props.ts";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";

export type Destination = { folderId: string | null; ownerProjectId?: string };
export function ScopeTabs({
  p,
  project,
  onChange,
}: {
  p: CanvasProps;
  project: boolean;
  onChange(project: boolean): void;
}) {
  return (
    <div
      className={css.libraryTabs}
      role="tablist"
      aria-label={p.t("assetScope")}
    >
      {[false, true].map((value) => (
        <Button
          key={String(value)}
          role="tab"
          aria-selected={project === value}
          data-active={project === value}
          onClick={() => onChange(value)}
        >
          {p.t(value ? "currentProject" : "personalAssets")}
        </Button>
      ))}
    </div>
  );
}

export function FolderPicker({
  p,
  initial,
  busy = false,
  locked = false,
  progress,
  error: externalError,
  onClose,
  onConfirm,
}: {
  p: CanvasProps;
  initial: Destination;
  busy?: boolean;
  locked?: boolean;
  progress?: string;
  error?: string;
  onClose(): void;
  onConfirm(destination: Destination): void;
}) {
  const projectId = p.useStudio((s) => s.current!.id);
  const [project, setProject] = useState(!!initial.ownerProjectId);
  const [selected, setSelected] = useState(initial.folderId);
  const [folders, setFolders] = useState<CreativeFolder[]>([]);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [creating, setCreating] = useState(false),
    [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const ownerProjectId = project ? projectId : undefined;
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void p
      .request("creativeFolders", { projectId: ownerProjectId }, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        setFolders(value);
        setSelected((old) =>
          old && value.some((f) => f.id === old) ? old : null,
        );
        const ancestors = new Set<string>();
        let parent = value.find((f) => f.id === initial.folderId)?.parentId;
        while (parent) {
          ancestors.add(parent);
          parent = value.find((f) => f.id === parent)?.parentId;
        }
        setExpanded(ancestors);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [ownerProjectId]);
  const disabled = busy || saving;
  async function create() {
    if (disabled || !name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const folder = await p.request("createCreativeFolder", {
        name: name.trim(),
        parentId: selected,
        projectId: ownerProjectId,
      });
      setFolders((old) => [...old, folder]);
      setSelected(folder.id);
      if (folder.parentId)
        setExpanded((old) => new Set([...old, folder.parentId!]));
      setCreating(false);
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  function tree(parentId: string | null, depth = 0) {
    return folders
      .filter((f) => f.parentId === parentId)
      .map((folder) => {
        const hasChildren = folders.some((f) => f.parentId === folder.id),
          open = expanded.has(folder.id);
        return (
          <div key={folder.id}>
            <div
              className={css.folderChoice}
              data-active={selected === folder.id}
              style={{ paddingLeft: 8 + depth * 20 }}
            >
              <Button
                className={css.folderChevron}
                disabled={!hasChildren || disabled}
                aria-label={p.t(open ? "collapseFolder" : "expandFolder")}
                aria-expanded={open}
                onClick={() =>
                  setExpanded((old) => {
                    const next = new Set(old);
                    if (next.has(folder.id)) next.delete(folder.id);
                    else next.add(folder.id);
                    return next;
                  })
                }
              >
                <span data-open={open}>
                  <Icon name="down" size={14} />
                </span>
              </Button>
              <button
                disabled={disabled}
                onClick={() => setSelected(folder.id)}
              >
                <Icon name="folder" size={22} />
                <span>{folder.name}</span>
                {selected === folder.id && <Icon name="check" size={18} />}
              </button>
            </div>
            {open && tree(folder.id, depth + 1)}
          </div>
        );
      });
  }
  return (
    <Modal
      open
      title={p.t("chooseFolder")}
      className={css.folderDialog}
      onClose={() => !saving && !locked && onClose()}
      closeLabel={p.t("close")}
      footer={
        <>
          <Button disabled={saving || locked} onClick={onClose}>
            {p.t(busy ? "stop" : "cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={disabled || loading || !!error || creating}
            onClick={() => onConfirm({ folderId: selected, ownerProjectId })}
          >
            {p.t(busy ? "saving" : "confirm")}
          </Button>
        </>
      }
    >
      <div data-studio-assets>
        <fieldset disabled={disabled} className={css.folderScope}>
          <ScopeTabs
            p={p}
            project={project}
            onChange={(value) => {
              setProject(value);
              setSelected(null);
              setCreating(false);
            }}
          />
        </fieldset>
        <div className={css.folderPickerToolbar}>
          <Button
            disabled={disabled || loading}
            onClick={() => {
              setCreating(!creating);
              setName("");
            }}
          >
            <Icon name="plus" size={16} />
            {p.t("newFolder")}
          </Button>
        </div>
        {creating && (
          <form
            className={css.folderInlineForm}
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Input
              autoFocus
              className={css.libraryInput}
              value={name}
              maxLength={80}
              disabled={disabled}
              placeholder={p.t("folderName")}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" disabled={disabled || !name.trim()}>
              {p.t("createFolder")}
            </Button>
          </form>
        )}
        <div className={css.folderPickerTree} aria-busy={loading}>
          <div className={css.folderChoice} data-active={!selected}>
            <button disabled={disabled} onClick={() => setSelected(null)}>
              <Icon name="folder" size={22} />
              <span>{p.t("rootFolder")}</span>
              {!selected && <Icon name="check" size={18} />}
            </button>
          </div>
          {loading ? (
            <div className={css.folderLoading}>{p.t("opening")}</div>
          ) : (
            tree(null)
          )}
        </div>
        {(progress || externalError || error) && (
          <div
            className={css.libraryNotice}
            role={externalError || error ? "alert" : "status"}
          >
            {externalError || error || progress}
          </div>
        )}
      </div>
    </Modal>
  );
}

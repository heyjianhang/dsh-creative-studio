import { MediaSettings } from "./media-settings.tsx";
import { useId, useRef, useState, type ComponentType } from "react";
import {
  Button,
  Input,
  Modal,
  SegmentedControl,
  useModalLayer,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PageProps, CanvasProps, Shared } from "./props.ts";
import type { LibrarySettingsNavigation } from "../asset-library/client/props.ts";
import type { Project } from "../shared/contracts.ts";
import { Icon } from "./icons.tsx";
import { Canvas } from "./canvas.tsx";
import { ProjectCard, ProjectCardMenu } from "./project-card.tsx";
import { TemplateLibrary } from "./template-library.tsx";
import {
  templateNodeData,
  templateReferenceGraph,
} from "../shared/template-application.ts";
import css from "./studio.module.css";
import ui from "./collection.module.css";
import {
  CollectionSearch,
  CollectionTypes,
  CollectionSelect,
} from "./collection-ui.tsx";
function ProjectListCard({
  project,
  p,
  onRename,
  onDelete,
}: {
  project: Project;
  p: Shared;
  onRename(): void;
  onDelete(): void;
}) {
  const cover = project.nodes.find(
    (n) => n.data.kind === "image" && (n.data.media || n.data.asset),
  );
  return (
    <ProjectCard
      p={p}
      name={project.name}
      date={project.updatedAt}
      count={project.nodes.length}
      cover={cover?.data}
      owner={{ projectId: project.id }}
      onOpen={() =>
        void p.openProject(project.id).catch((e) => p.notify(e.message))
      }
      actions={
        <ProjectCardMenu
          label={`${project.name} · ${p.t("more")}`}
          items={[
            { id: "rename", label: p.t("rename") },
            { id: "delete", label: p.t("delete") },
          ]}
          onSelect={(id) => (id === "rename" ? onRename() : onDelete())}
        />
      }
    />
  );
}
export function Page(p: PageProps) {
  const s = p.useStudio((x) => x);
  const [query, setQuery] = useState(""),
    [dialog, setDialog] = useState<{
      kind: "create" | "rename" | "delete";
      project?: Project;
    } | null>(null),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [view, setView] = useState<"grid" | "list">("grid"),
    [sort, setSort] = useState<"updated" | "nameSort">("updated");
  const openDialog = (
    kind: "create" | "rename" | "delete",
    project?: Project,
  ) => {
    setName(project?.name ?? p.t("untitled"));
    setError("");
    setDialog({ kind, project });
  };
  const submit = async () => {
    if (!dialog) return;
    setBusy(true);
    setError("");
    try {
      if (dialog.kind === "create") await p.createProject(name);
      else if (dialog.kind === "rename")
        await p.request("save", { project: { ...dialog.project!, name } });
      else
        await p.request("removeProject", {
          id: dialog.project!.id,
          revision: dialog.project!.revision,
        });
      await p.refresh();
      setDialog(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const items = s.projects
    .filter((x) => x.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) =>
      sort === "nameSort"
        ? a.name.localeCompare(b.name)
        : b.updatedAt.localeCompare(a.updatedAt),
    );
  if (s.current)
    return <Canvas key={s.current.id + ":" + p.editor.reloadCount} {...p} />;
  return (
    <div className={`${css.page} ${ui.surface}`}>
      {s.error && (
        <div className={css.error} role="alert">
          {s.error}
          <Button
            size="sm"
            onClick={() => void p.refresh().catch((e) => p.notify(e.message))}
          >
            {p.t("retry")}
          </Button>
        </div>
      )}
      <div className={css.managementLayout}>
        <main
          className={
            s.page === "assets"
              ? css.assetsContent
              : s.page === "templates"
                ? css.templateContent
                : ui.content
          }
          key={s.page}
        >
          {s.page === "assets" ? (
            p.renderLibrary()
          ) : s.page === "templates" ? (
            <TemplateLibrary
              management
              p={p}
              onUseCanvas={async (id) => {
                const project = await p.request("createFromCanvasTemplate", {
                  id,
                });
                await p.openProject(project.id);
              }}
              onUse={async (template, urls) => {
                const project = await p.request("create", {
                  name: template.title.slice(0, 120),
                });
                let saved = false;
                try {
                  const media = urls.length
                    ? await p.request("templateMedia", {
                        projectId: project.id,
                        id: template.id,
                        urls,
                      })
                    : [];
                  const graph = templateReferenceGraph(
                    {
                      id: crypto.randomUUID(),
                      type: "creative",
                      position: { x: media.length ? 420 : 180, y: 140 },
                      data: templateNodeData(project, template),
                    },
                    media,
                  );
                  await p.request("save", {
                    project: {
                      ...project,
                      nodes: graph.nodes,
                      edges: graph.edges,
                    },
                  });
                  saved = true;
                  await p.openProject(project.id);
                  p.focusNode(graph.nodeId);
                  await p.refresh();
                } catch (error) {
                  if (!saved)
                    await p
                      .request("removeProject", {
                        id: project.id,
                        revision: project.revision,
                      })
                      .catch(() => {});
                  throw error;
                }
              }}
            />
          ) : (
            <>
              <div className={ui.toolbar}>
                <CollectionSearch
                  aria-label={p.t("search")}
                  placeholder={p.t("search")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  clearLabel={p.t("clearSearch")}
                  onClear={() => setQuery("")}
                />
                <CollectionTypes<typeof view>
                  value={view}
                  label={p.t("view")}
                  options={(["grid", "list"] as const).map((value) => ({
                    value,
                    label: p.t(value === "grid" ? "gridView" : "listView"),
                    icon: <Icon name={value} size={16} />,
                  }))}
                  onChange={setView}
                />
                <div className={ui.resultTools}>
                  <span className={ui.srOnly} role="status">
                    {items.length} {p.t("projectCount")}
                  </span>
                  <CollectionSelect<typeof sort>
                    compact
                    label={p.t("sort")}
                    value={sort}
                    options={(["updated", "nameSort"] as const).map((id) => ({
                      id,
                      label: p.t(id),
                    }))}
                    onChange={setSort}
                  />
                  <Button
                    variant="primary"
                    onClick={() => openDialog("create")}
                  >
                    <Icon name="plus" size={16} />
                    {p.t("create")}
                  </Button>
                </div>
              </div>
              {!items.length ? (
                <div className={ui.empty}>
                  <Icon name="search" size={36} />
                  <h2>{p.t(query ? "noSearch" : "noProjects")}</h2>
                  <Button
                    onClick={() =>
                      query ? setQuery("") : openDialog("create")
                    }
                  >
                    {p.t(query ? "clearSearch" : "create")}
                  </Button>
                </div>
              ) : (
                <div className={ui.grid} data-view={view}>
                  {items.map((project) => (
                    <ProjectListCard
                      key={project.id}
                      project={project}
                      p={p}
                      onRename={() => openDialog("rename", project)}
                      onDelete={() => openDialog("delete", project)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </main>
      </div>
      <Modal
        open={!!dialog && !s.current}
        onClose={() => !busy && setDialog(null)}
        title={p.t(
          dialog?.kind === "rename"
            ? "rename"
            : dialog?.kind === "delete"
              ? "delete"
              : "create",
        )}
        closeLabel={p.t("close")}
        footer={
          <>
            <Button disabled={busy} onClick={() => setDialog(null)}>
              {p.t("cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy || !name.trim()}
              onClick={() => void submit()}
            >
              {p.t(
                dialog?.kind === "delete"
                  ? "delete"
                  : dialog?.kind === "rename"
                    ? "save"
                    : "create",
              )}
            </Button>
          </>
        }
      >
        {dialog?.kind === "delete" ? (
          <p>{p.t("deleteHint")}</p>
        ) : (
          <label className={css.field}>
            {p.t("name")}
            <Input
              data-modal-autofocus
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing)
                  void submit();
              }}
            />
          </label>
        )}
        {error && (
          <p role="alert" className={css.error}>
            {error}
          </p>
        )}
      </Modal>
    </div>
  );
}
/** Mount the model and asset settings under one workbench settings section. */
export function Settings(
  p: Shared & { LibrarySettings?: ComponentType<LibrarySettingsNavigation> },
) {
  const id = useId();
  const [tab, setTab] = useState<"models" | "library">("models");
  const { LibrarySettings } = p;
  return (
    <>
      <div className={css.studioSettingsTabs}>
        <SegmentedControl
          id={id}
          label={p.t("settings")}
          value={tab}
          options={[
            { value: "models", label: p.t("settingsConnections") },
            { value: "library", label: p.t("assets") },
          ]}
          onChange={setTab}
        />
      </div>
      <div
        role="tabpanel"
        id={`${id}-models-panel`}
        aria-labelledby={`${id}-models`}
        hidden={tab !== "models"}
      >
        <MediaSettings {...p} />
      </div>
      <div
        role="tabpanel"
        id={`${id}-library-panel`}
        aria-labelledby={`${id}-library`}
        hidden={tab !== "library"}
      >
        {LibrarySettings ? (
          <LibrarySettings
            openModelSettings={() => {
              setTab("models");
              document.getElementById(`${id}-models`)?.focus();
            }}
          />
        ) : (
          <p role="status">{p.t("loadingAssetSettings")}</p>
        )}
      </div>
    </>
  );
}

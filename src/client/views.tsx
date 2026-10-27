import { MediaSettings } from "./media-settings.tsx";
import { useRef, useState } from "react";
import {
  Button,
  Input,
  Modal,
  Menu,
  Tooltip,
  useModalLayer,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PageProps, CanvasProps, Shared } from "./props.ts";
import type { Project } from "../shared/contracts.ts";
import { Icon } from "./icons.tsx";
import { Canvas } from "./canvas.tsx";
import { MediaView } from "./media.tsx";
import css from "./studio.module.css";
export function StudioSurface(p: CanvasProps) {
  const active = p.usePanelInfo(
    (info) => info.activePanelId === "creative-studio",
  );
  const current = p.useStudio((s) => s.current?.id);
  const surface = useRef<HTMLDivElement>(null);
  useModalLayer(surface, active && !!current, () => {
    void p.navigate("projects").catch((e) => p.notify(e.message));
  });
  if (!active || !current) return null;
  return (
    <div
      ref={surface}
      className={css.studioSurface}
      role="dialog"
      aria-modal="true"
      aria-label={p.t("title")}
      tabIndex={-1}
      data-studio-surface
      data-shortcut-modal="creative-studio"
    >
      <Canvas key={current} {...p} />
    </div>
  );
}
function ProjectCard({
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
  const [menu, setMenu] = useState(false);
  const cover = project.nodes.find(
    (n) => n.data.kind === "image" && (n.data.media || n.data.asset),
  );
  return (
    <article className={css.projectCard}>
      <button
        className={css.projectOpen}
        onClick={() =>
          void p.openProject(project.id).catch((e) => p.notify(e.message))
        }
      >
        <div className={css.projectCover}>
          {cover ? (
            <MediaView
              request={p.request}
              projectId={project.id}
              data={cover.data}
              preview
            />
          ) : (
            <div className={css.miniCanvas}>
              <i />
              <Icon
                name={project.nodes.length ? "text" : "sparkle"}
                size={30}
              />
              <i />
            </div>
          )}
        </div>
        <div className={css.projectInfo}>
          <strong>{project.name}</strong>
          <span>
            {project.nodes.length} {p.t("nodes")}
            <i>·</i>
            {new Date(project.updatedAt).toLocaleDateString()}
          </span>
        </div>
      </button>
      <div className={css.projectMenu} data-open={menu}>
        <Menu
          open={menu}
          onClose={() => setMenu(false)}
          portal
          anchor={
            <Button
              size="sm"
              aria-label={project.name + " " + p.t("more")}
              onClick={() => setMenu(!menu)}
            >
              <Icon name="more" />
            </Button>
          }
          items={[
            { id: "rename", label: p.t("rename") },
            { id: "delete", label: p.t("delete") },
          ]}
          onSelect={(id) => {
            setMenu(false);
            id === "rename" ? onRename() : onDelete();
          }}
        />
      </div>
    </article>
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
    [sort, setSort] = useState<"updated" | "nameSort">("updated"),
    [sortOpen, setSortOpen] = useState(false);
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
  return (
    <div className={css.page}>
      <header className={css.studioHeader}>
        <div className={css.studioBrand}>
          <strong>{p.t("title")}</strong>
        </div>
        <nav className={css.studioTabs} aria-label={p.t("navigation")}>
          {(["projects", "templates"] as const).map((page) => (
            <Button
              key={page}
              aria-current={s.page === page ? "page" : undefined}
              onClick={() =>
                void p.navigate(page).catch((e) => p.notify(e.message))
              }
            >
              <Icon name={page === "projects" ? "folder" : "grid"} size={18} />
              {p.t(page)}
            </Button>
          ))}
        </nav>
        <div className={css.headerBalance} aria-hidden />
      </header>
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
      <main className={css.projectContent}>
        {s.page === "templates" ? (
          <div className={css.empty}>
            <Icon name="grid" size={38} />
            <h2>{p.t("templateEmpty")}</h2>
            <p>{p.t("templateSub")}</p>
          </div>
        ) : (
          <>
            <div className={css.projectToolbar}>
              <div className={css.projectHeading}>
                <h1>{p.t("projects")}</h1>
                <span>
                  {s.projects.length} {p.t("projectCount")}
                </span>
              </div>
              <div className={css.projectActions}>
                <div className={css.projectSearch}>
                  <Icon name="search" size={18} />
                  <Input
                    aria-label={p.t("search")}
                    placeholder={p.t("search")}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <Menu
                  open={sortOpen}
                  onClose={() => setSortOpen(false)}
                  selectedId={sort}
                  portal
                  anchor={
                    <Button
                      onClick={() => setSortOpen(!sortOpen)}
                      aria-label={p.t("sort")}
                      aria-expanded={sortOpen}
                    >
                      {p.t(sort)}
                      <Icon name="down" size={16} />
                    </Button>
                  }
                  items={(["updated", "nameSort"] as const).map((id) => ({
                    id,
                    label: p.t(id),
                  }))}
                  onSelect={(id) => {
                    setSort(id as typeof sort);
                    setSortOpen(false);
                  }}
                />
                <div
                  className={css.viewToggle}
                  role="group"
                  aria-label={p.t("view")}
                >
                  {(["grid", "list"] as const).map((mode) => (
                    <Tooltip
                      key={mode}
                      label={p.t(mode === "grid" ? "gridView" : "listView")}
                    >
                      <Button
                        aria-label={p.t(
                          mode === "grid" ? "gridView" : "listView",
                        )}
                        aria-pressed={view === mode}
                        onClick={() => setView(mode)}
                      >
                        <Icon name={mode} size={18} />
                      </Button>
                    </Tooltip>
                  ))}
                </div>
                <Button variant="primary" onClick={() => openDialog("create")}>
                  <Icon name="plus" />
                  {p.t("create")}
                </Button>
              </div>
            </div>
            {query && !items.length ? (
              <div className={css.empty}>
                <Icon name="search" size={36} />
                <h2>{p.t("noSearch")}</h2>
                <Button onClick={() => setQuery("")}>
                  {p.t("clearSearch")}
                </Button>
              </div>
            ) : (
              <div className={css.projects} data-view={view}>
                {items.map((project) => (
                  <ProjectCard
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
export function Settings(p: Shared) {
  return <MediaSettings {...p} />;
}

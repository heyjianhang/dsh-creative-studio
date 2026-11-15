/** Author-owned workbench header shared with the current creative view. */
import {
  Button,
  Input,
  Menu,
  Modal,
  Tooltip,
  IconSettingsOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { useState } from "react";
import type { WorkbenchHeaderProps } from "@actvero/dsh-capability-ui/client/contracts";
import type { Shared } from "./props.ts";
import { Icon } from "./icons.tsx";
import { ProjectNavigation } from "./project-navigation.tsx";
import css from "./studio.module.css";
import ui from "./collection.module.css";

/** Render navigation or the active project without a second business title bar.
 * @param p Native workbench capabilities and the shared creative state.
 * @returns Compact adaptive header.
 */
export function WorkbenchHeader(p: WorkbenchHeaderProps & Shared) {
  const state = p.useStudio((s) => s);
  return (
    <div
      className={state.current ? css.workbenchHeader : ui.navigation}
      data-management={!state.current || undefined}
    >
      {state.current ? (
        <>
          <ProjectNavigation {...p} />
          <div className={css.projectHeaderActions}>
            <span
              className={css.saveState}
              data-error={state.status === "error"}
            >
              {p.t(
                state.status === "error"
                  ? "unsaved"
                  : state.status === "saving"
                    ? "saving"
                    : "saved",
              )}
            </span>
            <SaveCanvasTemplate key={state.current.id} {...p} />
          </div>
        </>
      ) : (
        <>
          <span className={ui.navigationTitle}>{p.t("title")}</span>
          <nav className={ui.navigationTabs} aria-label={p.t("navigation")}>
            {(["projects", "assets", "templates"] as const).map((page) => (
              <Button
                key={page}
                aria-current={state.page === page ? "page" : undefined}
                onClick={() =>
                  void p
                    .navigate(page)
                    .catch((error) => p.notify(error.message))
                }
              >
                <Icon
                  name={page === "templates" ? "grid" : "folder"}
                  size={16}
                />
                <span>{p.t(page)}</span>
              </Button>
            ))}
          </nav>
        </>
      )}
      {!state.current && (
        <Tooltip label={p.t("settings")} portal>
          <Button
            size="sm"
            className={ui.navigationSettings}
            aria-label={p.t("settings")}
            onClick={() => p.workbench && p.openSettings()}
          >
            <IconSettingsOutlineRegular size={18} />
          </Button>
        </Tooltip>
      )}
    </div>
  );
}

function SaveCanvasTemplate(p: Shared) {
  const project = p.useStudio((s) => s.current)!;
  const [name, setName] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const close = () => {
    if (!busy) setName(null);
  };
  const save = async () => {
    if (busy || !name?.trim()) return;
    setBusy(true);
    setError("");
    try {
      await p.editor.flush();
      const current = p.editor.current;
      if (current?.id !== project.id)
        throw new Error(p.t("templateCanvasChanged"));
      await p.request("saveCanvasTemplate", {
        projectId: current.id,
        revision: current.revision,
        name: name.trim(),
      });
      setName(null);
      p.notify(p.t("canvasTemplateSaved"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Menu
        portal
        autoFocus
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchor={
          <Button
            size="sm"
            className={css.projectHeaderMenu}
            aria-label={p.t("more")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <Icon name="more" size={18} />
          </Button>
        }
        items={[
          {
            id: "save-template",
            label: p.t("saveCanvasTemplate"),
            icon: <Icon name="grid" size={16} />,
            disabled: !project.nodes.length,
          },
        ]}
        onSelect={() => {
          setMenuOpen(false);
          setError("");
          setName(project.name);
        }}
      />
      {name !== null && (
        <Modal
          open
          title={p.t("saveCanvasTemplate")}
          closeLabel={p.t("close")}
          onClose={close}
          footer={
            <>
              <Button size="sm" disabled={busy} onClick={close}>
                {p.t("cancel")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !name.trim()}
                onClick={() => void save()}
              >
                {p.t(busy ? "saving" : "save")}
              </Button>
            </>
          }
        >
          <label className={css.settingsField}>
            {p.t("canvasTemplateName")}
            <Input
              data-modal-autofocus
              value={name}
              maxLength={120}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing)
                  void save();
              }}
            />
          </label>
          {error && (
            <p className={css.error} role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}

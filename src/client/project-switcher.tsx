import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  Button,
  Input,
  Menu,
  Modal,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { Project } from "../shared/contracts.ts";
import type { Shared } from "./props.ts";
import { Icon } from "./icons.tsx";
import { MediaView } from "./media.tsx";
import css from "./studio.module.css";

function Thumbnail({ project, p }: { project: Project; p: Shared }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const cover = project.nodes.find(
    (n) => n.data.kind === "image" && (n.data.media || n.data.asset),
  );
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={ref} className={css.switchThumbnail} aria-hidden="true">
      {cover && visible ? (
        <MediaView
          request={p.request}
          projectId={project.id}
          data={cover.data}
          preview
        />
      ) : (
        <Icon name="image" size={18} />
      )}
    </span>
  );
}

const CREATE = "action:create";

function ProjectOptions({
  p,
  pending,
  onChoose,
  onCreate,
}: {
  p: Shared;
  pending: boolean;
  onChoose(id: string): void;
  onCreate(): void;
}) {
  const state = p.useStudio((s) => s);
  const current = state.current!;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(current.id);
  const search = useRef<HTMLInputElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const projects = [
    current,
    ...state.projects
      .filter((item) => item.id !== current.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  ].filter((item) =>
    item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const choices = [...projects.map((item) => item.id), CREATE];
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      search.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  const activate = (id: string | undefined) => {
    if (pending || !id) return;
    if (id === CREATE) onCreate();
    else onChoose(id);
  };
  const keydown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.altKey || e.metaKey || e.ctrlKey) return;
    const inSearch = e.target === search.current;
    const arrows = e.key === "ArrowDown" || e.key === "ArrowUp";
    const edge = e.key === "Home" || e.key === "End";
    if (arrows || (edge && !inSearch)) {
      e.preventDefault();
      e.stopPropagation();
      if (pending) return;
      const from = choices.indexOf(active ?? "");
      const index =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? choices.length - 1
            : from < 0
              ? e.key === "ArrowUp"
                ? choices.length - 1
                : 0
              : (from + (e.key === "ArrowDown" ? 1 : -1) + choices.length) %
                choices.length;
      const id = choices[index];
      setActive(id);
      rows.current.get(id)?.focus({ preventScroll: true });
      rows.current.get(id)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" || (e.key === " " && !inSearch)) {
      e.preventDefault();
      e.stopPropagation();
      activate(active && choices.includes(active) ? active : projects[0]?.id);
    } else if (inSearch) {
      // Keep caret movement and text editing inside the search field.
      e.stopPropagation();
    }
  };
  const rowProps = (id: string) => ({
    ref: (element: HTMLButtonElement | null) => {
      if (element) rows.current.set(id, element);
      else rows.current.delete(id);
    },
    role: "menuitem" as const,
    disabled: pending,
    "data-active": active === id,
    onFocus: () => setActive(id),
    onPointerMove: (e: PointerEvent) => {
      if (e.pointerType !== "touch") setActive(id);
    },
  });
  return (
    <div
      className={css.switchContent}
      onKeyDownCapture={keydown}
      aria-busy={pending}
    >
      <div className={css.switchSearch}>
        <Input
          ref={search}
          className={css.switchSearchInput}
          icon={<Icon name="search" size={18} />}
          aria-label={p.t("searchCanvas")}
          placeholder={p.t("searchCanvas")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(null);
          }}
        />
      </div>
      <div className={css.switchOptions}>
        {projects.map((item) => (
          <Button
            {...rowProps(item.id)}
            key={item.id}
            className={css.switchRow}
            aria-current={item.id === current.id ? "page" : undefined}
            onClick={() => activate(item.id)}
          >
            <Thumbnail project={item} p={p} />
            <span className={css.switchLabel} title={item.name}>
              {item.name}
            </span>
            <span className={css.switchCheck}>
              {item.id === current.id && <Icon name="check" size={18} />}
            </span>
          </Button>
        ))}
        {!projects.length && (
          <p className={css.switchEmpty}>{p.t("noSearch")}</p>
        )}
      </div>
      <div className={css.switchFooter}>
        <Button
          {...rowProps(CREATE)}
          className={css.switchRow}
          onClick={() => activate(CREATE)}
        >
          <span className={css.switchActionIcon}>
            <Icon name="plus" size={20} />
          </span>
          <span>{p.t("create")}</span>
        </Button>
      </div>
    </div>
  );
}

export function ProjectSwitcher(p: Shared) {
  const project = p.useStudio((s) => s.current)!;
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const pill = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      await action();
    } catch (e) {
      if (alive.current) {
        const message = e instanceof Error ? e.message : String(e);
        if (dialog) setError(message);
        else p.notify(message);
      }
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  };
  const openMenu = () => {
    if (pending) return;
    if (!open) void p.refresh().catch((e) => p.notify(e.message));
    setOpen(!open);
  };
  const openDialog = () => {
    setOpen(false);
    setName(p.t("untitled"));
    setError("");
    setDialog(true);
  };
  const closeDialog = () => {
    setDialog(false);
    requestAnimationFrame(() =>
      trigger.current?.focus({ preventScroll: true }),
    );
  };
  const submit = () => {
    const value = name.trim();
    if (!value || !dialog || pending) return;
    void run(async () => {
      await p.createProject(value);
      if (alive.current) closeDialog();
    });
  };
  return (
    <div ref={pill} className={css.projectPill} data-project-switcher>
      <Tooltip label={p.t("returnProjects")}>
        <Button
          className={css.tool}
          disabled={pending}
          aria-label={p.t("returnProjects")}
          onClick={() => void run(() => p.navigate("projects"))}
        >
          <Icon name="back" />
        </Button>
      </Tooltip>
      <span className={css.pillDivider} aria-hidden="true" />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        portal
        className={css.switchAnchor}
        listClassName={css.switchMenu}
        getAnchorRect={() => pill.current?.getBoundingClientRect() ?? null}
        anchor={
          <Button
            ref={trigger}
            className={css.projectName}
            disabled={pending}
            aria-label={`${p.t("switchProject")} · ${project.name}`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={openMenu}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && !open) {
                e.preventDefault();
                openMenu();
              }
            }}
          >
            <span className={css.projectNameText} title={project.name}>
              {project.name}
            </span>
            <span className={css.projectChevron} data-open={open}>
              <Icon name="down" size={17} />
            </span>
          </Button>
        }
      >
        <ProjectOptions
          p={p}
          pending={pending}
          onCreate={openDialog}
          onChoose={(id) => {
            if (id === project.id) {
              setOpen(false);
              requestAnimationFrame(() =>
                trigger.current?.focus({ preventScroll: true }),
              );
              return;
            }
            void run(() => p.openProject(id));
          }}
        />
      </Menu>
      <Modal
        open={dialog}
        title={p.t("create")}
        closeLabel={p.t("close")}
        onClose={() => !pending && closeDialog()}
        footer={
          <>
            <Button disabled={pending} onClick={closeDialog}>
              {p.t("cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={pending || !name.trim()}
              onClick={submit}
            >
              {p.t(pending ? "saving" : "create")}
            </Button>
          </>
        }
      >
        <label className={css.field}>
          {p.t("name")}
          <Input
            data-modal-autofocus
            value={name}
            maxLength={120}
            disabled={pending}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </label>
        {error && (
          <p className={css.error} role="alert">
            {error}
          </p>
        )}
      </Modal>
    </div>
  );
}

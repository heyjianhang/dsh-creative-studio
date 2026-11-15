import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Button,
  Menu,
  Tooltip,
  IconCheckOutlineRegular,
  IconEllipsisOutlineRegular,
  IconEditOutlineRegular,
  IconTrashOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconChevronRightOutlineRegular,
  IconChevronDownOutlineRegular,
  IconPlusOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import css from "./folder-browser.module.css";

type Folder = {
  id: string;
  name: string;
  count: number;
  isDefault?: boolean;
};

/** Management actions available for user-created collections. */
export type CollectionAction = "rename" | "delete";

type ActionLabels = { more: string; rename: string; delete: string };

/** Flat collection navigation and row actions; dialogs are owned by the page. */
export function FolderMenu<F extends Folder>({
  folders,
  currentId,
  rootLabel,
  label,
  createLabel,
  onNavigate,
  onCreate,
  actionLabels,
  onAction,
}: {
  folders: F[];
  currentId?: string;
  rootLabel: string;
  label: string;
  createLabel: string;
  onNavigate(id?: string): void;
  onCreate(): void;
  actionLabels: ActionLabels;
  onAction(folder: F, action: CollectionAction): void;
}) {
  const [open, setOpen] = useState(false);
  const [actionId, setActionId] = useState<string>();
  const close = useCallback(() => {
    setOpen(false);
    setActionId(undefined);
  }, []);
  const navigate = (id?: string) => {
    onNavigate(id);
    close();
  };
  return (
    <Menu
      portal
      dense
      open={open}
      onClose={close}
      listClassName={css.folderMenu}
      anchor={
        <Button
          className={css.menuTrigger}
          aria-label={`${label} · ${folders.find((f) => f.id === currentId)?.name ?? rootLabel}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setActionId(undefined);
            setOpen(!open);
          }}
        >
          <IconFolderOpenOutlineRegular size={18} />
          <span>
            {folders.find((f) => f.id === currentId)?.name ?? rootLabel}
          </span>
          <IconChevronDownOutlineRegular size={14} />
        </Button>
      }
    >
      <div className={css.treeRow}>
        <Button
          role="menuitem"
          className={css.treeOpen}
          aria-current={!currentId ? "page" : undefined}
          onClick={() => navigate()}
        >
          <IconFolderOpenOutlineRegular size={16} />
          <span>{rootLabel}</span>
          {!currentId && <IconCheckOutlineRegular size={16} />}
        </Button>
      </div>
      {folders.length > 0 && (
        <div className={css.menuDivider} role="separator" />
      )}
      {folders.map((folder) => (
        <FolderMenuRow
          key={folder.id}
          folder={folder}
          current={folder.id === currentId}
          open={actionId === folder.id}
          onOpenChange={(value) =>
            setActionId((id) =>
              value ? folder.id : id === folder.id ? undefined : id,
            )
          }
          labels={actionLabels}
          onNavigate={() => navigate(folder.id)}
          onAction={(action) => {
            close();
            onAction(folder, action);
          }}
        />
      ))}
      <Button
        role="menuitem"
        className={css.createFolder}
        onClick={() => {
          close();
          onCreate();
        }}
      >
        <IconPlusOutlineRegular size={16} />
        {createLabel}
      </Button>
    </Menu>
  );
}

function FolderMenuRow({
  folder,
  current,
  open,
  onOpenChange,
  labels,
  onNavigate,
  onAction,
}: {
  folder: Folder;
  current: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  labels: ActionLabels;
  onNavigate(): void;
  onAction(action: CollectionAction): void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const rename = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    // Portal menus are hidden until their placement has been measured.
    const frame = requestAnimationFrame(() => rename.current?.focus());
    // The containing menu handles Escape on document capture.
    const returnToCollection = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "Escape" && event.key !== "ArrowLeft")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      trigger.current?.focus();
    };
    window.addEventListener("keydown", returnToCollection, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", returnToCollection, true);
    };
  }, [open, onOpenChange]);
  return (
    <div
      ref={row}
      className={css.treeRow}
      data-actions-open={open || undefined}
    >
      <Button
        role="menuitem"
        className={css.treeOpen}
        aria-current={current ? "page" : undefined}
        onClick={onNavigate}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" && !folder.isDefault) {
            event.preventDefault();
            event.stopPropagation();
            onOpenChange(true);
          }
        }}
      >
        <IconFolderOpenOutlineRegular size={16} />
        <span>{folder.name}</span>
        {current && <IconCheckOutlineRegular size={16} />}
      </Button>
      <span className={css.rowEnd}>
        <small className={css.rowCount}>{folder.count}</small>
        {!folder.isDefault && (
          <span
            className={css.rowAction}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Menu
              portal
              autoFocus
              side="right"
              open={open}
              onClose={() => onOpenChange(false)}
              getAnchorRect={() => row.current?.getBoundingClientRect() ?? null}
              listClassName={css.actionMenu}
              anchor={
                <Tooltip label={labels.more} side="top" portal disabled={open}>
                  <Button
                    ref={trigger}
                    role="menuitem"
                    className={css.moreButton}
                    aria-label={`${labels.more} · ${folder.name}`}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    onClick={() => onOpenChange(!open)}
                    icon={<IconEllipsisOutlineRegular size={16} />}
                  />
                </Tooltip>
              }
            >
              <Button
                ref={rename}
                role="menuitem"
                className={css.actionItem}
                icon={<IconEditOutlineRegular size={16} />}
                onClick={() => onAction("rename")}
              >
                {labels.rename}
              </Button>
              <Button
                role="menuitem"
                className={css.actionItem + " " + css.deleteAction}
                icon={<IconTrashOutlineRegular size={16} />}
                onClick={() => onAction("delete")}
              >
                {labels.delete}
              </Button>
            </Menu>
          </span>
        )}
      </span>
    </div>
  );
}

/** Browse flat collections in the canvas picker. */
export function FolderBrowser<F extends Folder>({
  folders,
  currentId,
  rootLabel,
  label,
  showPath = true,
  onNavigate,
  actions,
}: {
  folders: F[];
  currentId?: string;
  rootLabel: string;
  label: string;
  showPath?: boolean;
  onNavigate(id?: string): void;
  actions?(folder: F): ReactNode;
}) {
  const current = folders.find((folder) => folder.id === currentId);
  const path = current ? [current] : [];
  const children = currentId ? [] : folders;
  return (
    <section className={css.browser} aria-label={label}>
      {showPath && (
        <nav className={css.path} aria-label={label}>
          <Button
            aria-current={!currentId ? "page" : undefined}
            onClick={() => onNavigate()}
          >
            {rootLabel}
          </Button>
          {path.map((folder) => (
            <span key={folder.id}>
              <IconChevronRightOutlineRegular size={12} />
              <Button
                aria-current={folder.id === currentId ? "page" : undefined}
                onClick={() => onNavigate(folder.id)}
              >
                {folder.name}
              </Button>
            </span>
          ))}
        </nav>
      )}
      {children.length > 0 && (
        <div className={css.folders}>
          {children.map((folder) => (
            <div className={css.folder} key={folder.id}>
              <Button
                className={css.open}
                onClick={() => onNavigate(folder.id)}
              >
                <IconFolderOpenOutlineRegular size={18} />
                <span>{folder.name}</span>
                <small>{folder.count}</small>
                <IconChevronRightOutlineRegular size={14} />
              </Button>
              {actions?.(folder)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

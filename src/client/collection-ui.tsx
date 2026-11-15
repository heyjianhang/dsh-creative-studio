import {
  Children,
  forwardRef,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Button,
  Input,
  SegmentedControl,
  Menu,
  Modal,
  IconSlidersTwoOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { Icon } from "./icons.tsx";
import css from "./collection.module.css";

/** Native search input with a stable trailing action area and optional clear action. */
export const CollectionSearch = forwardRef<
  HTMLInputElement,
  Omit<ComponentProps<typeof Input>, "icon"> & {
    clearLabel: string;
    onClear(): void;
    actions?: ReactNode;
  }
>(function CollectionSearch(
  { clearLabel, onClear, actions, className, ...input },
  ref,
) {
  return (
    <div className={`${css.search} ${className ?? ""}`}>
      <Input {...input} ref={ref} icon={<Icon name="search" size={18} />} />
      <Button
        size="sm"
        className={css.clear}
        data-empty={!input.value}
        aria-label={clearLabel}
        disabled={!input.value}
        onClick={onClear}
      >
        <Icon name="close" size={14} />
      </Button>
      {actions}
    </div>
  );
});

/** Shared segments. An id selects tab semantics; collection filters use pressed buttons. */
export function CollectionTypes<Value extends string>(props: {
  id?: string;
  value: Value;
  options: { value: Value; label: string; icon?: ReactNode }[];
  onChange(value: Value): void;
  label: string;
}) {
  if (props.id)
    return <SegmentedControl {...props} id={props.id} className={css.types} />;
  return (
    <div className={css.types} role="group" aria-label={props.label}>
      {props.options.map((option) => (
        <Button
          key={option.value}
          aria-label={option.label}
          title={option.icon ? option.label : undefined}
          aria-pressed={props.value === option.value}
          onClick={() => props.onChange(option.value)}
        >
          {option.icon ?? option.label}
        </Button>
      ))}
    </div>
  );
}

/** Native select menu shared by collection sorting, filters and canvas pickers. */
export function CollectionSelect<Value extends string>(props: {
  label: string;
  value: Value;
  options: { id: Value; label: string }[];
  onChange(value: Value): void;
  disabled?: boolean;
  placeholder?: string;
  compact?: boolean;
  prefix?: string;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={css.select} data-compact={props.compact || undefined}>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        portal
        dense
        compact
        minWidthFromAnchor
        selectedId={props.value}
        listClassName={css.selectList}
        anchor={
          <Button
            variant={props.compact ? "ghost" : "outline"}
            disabled={props.disabled}
            aria-label={props.label}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {props.icon}
            {props.prefix && <small>{props.prefix}</small>}
            <span>
              {props.options.find((o) => o.id === props.value)?.label ??
                props.placeholder ??
                props.label}
            </span>
            <Icon name="down" size={14} />
          </Button>
        }
        items={props.options}
        onSelect={(id) => {
          const option = props.options.find((entry) => entry.id === id);
          if (option) props.onChange(option.id);
          setOpen(false);
        }}
      />
    </div>
  );
}

/** Stable-width filter trigger; changing the active count never displaces nearby controls. */
export function CollectionFilterButton(props: {
  label: string;
  open: boolean;
  count: number;
  onClick(): void;
}) {
  return (
    <Button
      className={css.filterButton}
      aria-expanded={props.open}
      onClick={props.onClick}
    >
      <IconSlidersTwoOutlineRegular size={16} />
      {props.label}
      <span
        className={css.filterCount}
        data-empty={!props.count}
        aria-hidden={!props.count}
      >
        {props.count || ""}
      </span>
    </Button>
  );
}

/** Overlay filters keep the collection width and scroll position unchanged. */
export function CollectionFilterDrawer(props: {
  title: string;
  summary?: ReactNode;
  closeLabel: string;
  resetLabel: string;
  doneLabel: string;
  active: boolean;
  onClose(): void;
  onReset(): void;
  children: ReactNode;
}) {
  return (
    <Modal
      open
      headless
      title={props.title}
      onClose={props.onClose}
      className={css.drawer}
      backdropBlur={false}
    >
      <header className={css.drawerHeader}>
        <div>
          <h2>{props.title}</h2>
          {props.summary && (
            <p className={css.drawerSummary} role="status">
              {props.summary}
            </p>
          )}
        </div>
        <Button
          data-modal-autofocus
          aria-label={props.closeLabel}
          onClick={props.onClose}
        >
          <Icon name="close" size={18} />
        </Button>
      </header>
      <div className={css.drawerBody}>{props.children}</div>
      <footer className={css.drawerFooter}>
        <Button disabled={!props.active} onClick={props.onReset}>
          {props.resetLabel}
        </Button>
        <Button variant="primary" onClick={props.onClose}>
          {props.doneLabel}
        </Button>
      </footer>
    </Modal>
  );
}

/** Keeps source order while packing cards using their decoded media height. */
export const CollectionMasonry = forwardRef<
  HTMLDivElement,
  { children: ReactNode }
>(function CollectionMasonry({ children }, ref) {
  const container = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const contents = container.current?.querySelectorAll<HTMLElement>(
      "[data-masonry-content]",
    );
    const resize = (content: HTMLElement) => {
      const item = content.parentElement;
      if (item)
        item.style.gridRowEnd = `span ${Math.max(1, Math.ceil(content.getBoundingClientRect().height))}`;
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) resize(entry.target as HTMLElement);
    });
    contents?.forEach((content) => {
      resize(content);
      observer.observe(content);
    });
    return () => observer.disconnect();
  }, [children]);
  return (
    <div
      className={css.mediaGrid}
      ref={(element) => {
        container.current = element;
        if (typeof ref === "function") ref(element);
        else if (ref) ref.current = element;
      }}
    >
      {Children.map(children, (child) => (
        <div className={css.masonryItem}>
          <div className={css.masonryContent} data-masonry-content>
            {child}
          </div>
        </div>
      ))}
    </div>
  );
});

/** Cover, title, metadata and a separate menu share geometry across projects and templates. */
export function CollectionCard({
  title,
  subtitle,
  cover,
  actions,
  onOpen,
  openLabel,
  disabled,
}: {
  title: string;
  subtitle: ReactNode;
  cover: ReactNode;
  actions?: ReactNode;
  onOpen(): void;
  openLabel?: string;
  disabled?: boolean;
}) {
  return (
    <article className={css.card} data-collection-card data-actions={!!actions}>
      <button
        type="button"
        className={css.cardOpen}
        onClick={onOpen}
        disabled={disabled}
        aria-label={openLabel}
      >
        <div className={css.cover}>{cover}</div>
        <div className={css.info}>
          <strong title={title}>{title}</strong>
          <span>{subtitle}</span>
        </div>
      </button>
      {actions && <div className={css.cardActions}>{actions}</div>}
    </article>
  );
}

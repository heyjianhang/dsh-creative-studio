import { useState, type ComponentProps, type ReactNode } from "react";
import { Button, Menu } from "@deepseek-ai/dsh-client-ui-primitives";
import type { CreativeNode } from "../shared/contracts.ts";
import type { Shared } from "./props.ts";
import { Icon } from "./icons.tsx";
import { MediaView } from "./media.tsx";
import css from "./studio.module.css";
import { CollectionCard } from "./collection-ui.tsx";

/** Present projects and canvas templates with the same cover and title. */
export function ProjectCard({
  p,
  name,
  date,
  count,
  cover,
  owner,
  onOpen,
  actions,
  openLabel,
  disabled,
}: {
  p: Shared;
  name: string;
  date: string;
  count: number;
  cover?: CreativeNode["data"];
  owner:
    | { projectId: string; templateId?: never }
    | { templateId: string; projectId?: never };
  onOpen(): void;
  actions?: ReactNode;
  openLabel?: string;
  disabled?: boolean;
}) {
  return (
    <CollectionCard
      title={name}
      subtitle={
        <>
          {count} {p.t("nodes")}
          <i>·</i>
          {new Date(date).toLocaleDateString()}
        </>
      }
      cover={
        <>
          <div className={css.miniCanvas}>
            <i />
            <Icon name={count ? "text" : "sparkle"} size={30} />
            <i />
          </div>
          {cover && (
            <MediaView
              request={p.request}
              {...owner}
              data={cover}
              preview
              cover
            />
          )}
        </>
      }
      onOpen={onOpen}
      openLabel={openLabel}
      disabled={disabled}
      actions={actions}
    />
  );
}

/** Position the item actions alongside the shared card title. */
export function ProjectCardMenu({
  label,
  items,
  onSelect,
  disabled,
}: {
  label: string;
  items: ComponentProps<typeof Menu>["items"];
  onSelect(id: string): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-open={open}>
      <Menu
        portal
        open={open}
        onClose={() => setOpen(false)}
        anchor={
          <Button
            size="sm"
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => setOpen(!open)}
          >
            <Icon name="more" />
          </Button>
        }
        items={items}
        onSelect={(id) => {
          setOpen(false);
          onSelect(id);
        }}
      />
    </div>
  );
}

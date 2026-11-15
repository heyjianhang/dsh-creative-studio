import { useEffect, useRef, useState } from "react";
import { CollectionSelect } from "./collection-ui.tsx";
import type {
  CreativeAsset,
  CreativeAssetDraft,
  CreativeNode,
  Resource,
} from "../shared/contracts.ts";
import type { Shared } from "./props.ts";
import { MediaView } from "./media.tsx";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";

export const resourceKey = (r: Resource) =>
  r.media
    ? `media:${r.media.id}`
    : JSON.stringify([r.asset!.libraryId, r.asset!.id]);
export const resourceName = (r: Resource) => (r.media ?? r.asset)!.name;
export function nodeResource({
  kind,
  media,
  asset,
}: CreativeNode["data"]): Resource | undefined {
  if (kind === "text") return undefined;
  if (media) return { kind, media };
  if (asset) return { kind, asset };
}
export const uniqueResources = (refs: Resource[]) => [
  ...new Map(refs.map((r) => [resourceKey(r), r])).values(),
];
export interface AssetDraft {
  value: CreativeAssetDraft;
  record?: CreativeAsset;
}
export const newDraft = (refs: Resource[] = []): AssetDraft => ({
  value: {
    name: refs[0]
      ? resourceName(refs[0])
          .replace(/\.[^.]+$/, "")
          .slice(0, 120)
      : "",
    description: "",
    category: "other",
    references: uniqueResources(refs),
  },
});
export function AssetThumbnail({
  p,
  resource,
}: {
  p: Shared;
  resource: Resource;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const projectId = p.useStudio((s) => s.current!.id);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={element} className={css.libraryThumbnail}>
      {visible ? (
        <MediaView
          request={p.request}
          projectId={projectId}
          data={{ ...resource, label: resourceName(resource), text: "" }}
          preview
        />
      ) : (
        <Icon name={resource.kind} size={24} />
      )}
      {resource.kind === "video" && (
        <span className={css.thumbnailPlay}>
          <Icon name="play" size={13} />
        </span>
      )}
    </div>
  );
}
export function LibrarySelect({
  label,
  value,
  options,
  onChange,
  folder = false,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange(id: string): void;
  folder?: boolean;
}) {
  return (
    <CollectionSelect
      compact
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      icon={folder ? <Icon name="folder" size={15} /> : undefined}
    />
  );
}

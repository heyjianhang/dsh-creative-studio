import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ModelCatalog, ModelSelection } from "../shared/contracts.ts";
import type { Shared } from "./props.ts";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";

export function TextModelPicker({
  catalog,
  selection,
  p,
  onSelect,
  onRetry,
  renderModel,
  searchPlaceholder,
  searchable = true,
}: {
  catalog?: ModelCatalog;
  selection?: ModelSelection;
  p: Shared;
  onSelect(value: ModelSelection): void;
  onRetry(): void;
  renderModel?(model: NonNullable<ModelCatalog>["models"][number]): ReactNode;
  searchPlaceholder?: string;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const models =
    catalog?.models.filter((m) =>
      `${m.name} ${m.providerName} ${m.model}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    ) ?? [];
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (searchable) search.current?.focus();
      else {
        const index = models.findIndex(
          (m) =>
            m.provider === selection?.provider && m.model === selection?.model,
        );
        const item = list.current?.children[Math.max(0, index)] as
          HTMLElement | undefined;
        item?.focus({ preventScroll: true });
        item?.scrollIntoView({ block: "nearest" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const keydown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (!models.length) return;
      const next =
        active < 0
          ? e.key === "ArrowDown"
            ? 0
            : models.length - 1
          : (active + (e.key === "ArrowDown" ? 1 : -1) + models.length) %
            models.length;
      setActive(next);
      (list.current?.children[next] as HTMLElement)?.focus({
        preventScroll: true,
      });
      list.current?.children[next]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && models[active < 0 ? 0 : active]) {
      e.preventDefault();
      e.stopPropagation();
      onSelect(models[active < 0 ? 0 : active]);
    } else if (
      e.target === search.current &&
      e.key !== "Escape" &&
      e.key !== "Tab"
    )
      e.stopPropagation();
  };
  return (
    <div onKeyDownCapture={keydown}>
      {searchable && (
        <div className={css.modelSearch}>
          <Input
            className={css.modelSearchInput}
            ref={search}
            icon={<Icon name="search" size={16} />}
            value={query}
            placeholder={searchPlaceholder ?? p.t("searchModels")}
            aria-label={searchPlaceholder ?? p.t("searchModels")}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(-1);
            }}
          />
        </div>
      )}
      <div className={css.modelOptions} ref={list}>
        {models.map((m, i) => (
          <Button
            key={`${m.provider}:${m.model}`}
            role="menuitemradio"
            aria-checked={
              m.provider === selection?.provider && m.model === selection?.model
            }
            className={css.modelRow}
            data-active={i === active}
            onFocus={() => setActive(i)}
            onPointerMove={(e) => {
              if (e.pointerType !== "touch") setActive(i);
            }}
            onClick={() => onSelect(m)}
          >
            <span className={css.modelOption}>
              {renderModel ? (
                renderModel(m)
              ) : (
                <>
                  <strong>{m.name}</strong>
                  <small>
                    {m.providerName}
                    {m.images === "yes" ? ` · ${p.t("supportsImages")}` : ""}
                  </small>
                </>
              )}
            </span>
            {m.provider === selection?.provider &&
              m.model === selection?.model && <Icon name="check" size={16} />}
          </Button>
        ))}
        {!models.length && (
          <p>
            {p.t(!catalog ? "opening" : query ? "noSearch" : "modelMissing")}
          </p>
        )}
      </div>
      {!!catalog?.failures.length && (
        <Button className={css.retryModels} onClick={onRetry}>
          {p.t("retryModels")}
        </Button>
      )}
    </div>
  );
}

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ModelCatalog, ModelSelection } from "../shared/contracts.ts";
import type { Shared } from "./props.ts";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";

function tokenCount(value: number) {
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${+(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function TextModelPicker({
  catalog,
  selection,
  p,
  onSelect,
  onRetry,
  renderModel,
}: {
  catalog?: ModelCatalog;
  selection?: ModelSelection;
  p: Shared;
  onSelect(value: ModelSelection): void;
  onRetry(): void;
  renderModel?(model: NonNullable<ModelCatalog>["models"][number]): ReactNode;
}) {
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  const models = catalog?.models ?? [];
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const index = models.findIndex(
        (m) =>
          m.provider === selection?.provider && m.model === selection?.model,
      );
      const item = list.current?.children[Math.max(0, index)] as
        HTMLElement | undefined;
      item?.focus({ preventScroll: true });
      item?.scrollIntoView({ block: "nearest" });
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
    }
  };
  return (
    <div onKeyDownCapture={keydown}>
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
                <span className={css.mediaModelOption}>
                  <span className={css.mediaModelName}>
                    <Icon name="sparkle" size={21} />
                    <strong>{m.name}</strong>
                    <small className={css.mediaModelProvider}>
                      {m.providerName}
                    </small>
                  </span>
                  {(m.images === "yes" ||
                    m.contextWindow ||
                    m.defaultMaxTokens) && (
                    <span className={css.mediaModelBadges}>
                      {m.images === "yes" && (
                        <small>{p.t("supportsImages")}</small>
                      )}
                      {m.contextWindow && (
                        <small>
                          {p.t("modelContext")} {tokenCount(m.contextWindow)}
                        </small>
                      )}
                      {m.defaultMaxTokens && (
                        <small>
                          {p.t("modelDefaultOutput")}{" "}
                          {tokenCount(m.defaultMaxTokens)}
                        </small>
                      )}
                    </span>
                  )}
                </span>
              )}
            </span>
            {m.provider === selection?.provider &&
              m.model === selection?.model && <Icon name="check" size={16} />}
          </Button>
        ))}
        {!models.length && <p>{p.t(!catalog ? "opening" : "modelMissing")}</p>}
      </div>
      {!!catalog?.failures.length && (
        <Button className={css.retryModels} onClick={onRetry}>
          {p.t("retryModels")}
        </Button>
      )}
    </div>
  );
}

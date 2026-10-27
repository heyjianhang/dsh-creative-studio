import { Button, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";

export function GenerationSend({
  active,
  pending,
  disabled,
  label,
  stopLabel,
  onSubmit,
  onStop,
}: {
  active: boolean;
  pending: boolean;
  disabled: boolean;
  label: string;
  stopLabel: string;
  onSubmit(): void;
  onStop(): void;
}) {
  const running = active || pending;
  return (
    <Tooltip label={active ? stopLabel : label} portal>
      <Button
        className={css.generationSend}
        variant="primary"
        data-running={running}
        aria-busy={running || undefined}
        aria-label={active ? stopLabel : label}
        disabled={pending || (!active && disabled)}
        onClick={active ? onStop : onSubmit}
      >
        {running && <i className={css.sendSpinner} aria-hidden="true" />}
        <Icon name={active ? "stop" : "arrowUp"} size={active ? 14 : 22} />
      </Button>
    </Tooltip>
  );
}

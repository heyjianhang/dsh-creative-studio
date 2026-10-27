import { useState, type ReactNode } from "react";
import { Button, Menu, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";
export function Choice({
  value,
  options,
  onChange,
  label,
  disabled,
  side = "top",
  stretch = false,
}: {
  value: string;
  options: { id: string; label: string; icon?: ReactNode }[];
  onChange(value: string): void;
  label?: string;
  disabled?: boolean;
  side?: "top" | "bottom";
  stretch?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onClose={() => setOpen(false)}
      portal={!stretch}
      className={stretch ? css.mediaChoiceRoot : undefined}
      listClassName={stretch ? css.mediaChoiceList : undefined}
      side={side}
      selectedId={value}
      items={options}
      onSelect={(id) => {
        onChange(id);
        setOpen(false);
      }}
      anchor={
        <Button
          className={css.mediaChoice}
          disabled={disabled}
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span>
            {options.find((o) => o.id === value)?.icon}
            {options.find((o) => o.id === value)?.label ?? (value || label)}
          </span>
          <Icon name="down" size={14} />
        </Button>
      }
    />
  );
}
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange(value: boolean): void;
  label: string;
}) {
  return <Switch checked={checked} onChange={onChange} label={label} />;
}

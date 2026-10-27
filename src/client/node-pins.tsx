import { useState } from "react";
import { Button, Menu, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import { Tag } from "@phosphor-icons/react/dist/csr/Tag";
import type { CreativeNode } from "../shared/contracts.ts";
import type { Key } from "./locales.ts";
import css from "./studio.module.css";

export const pinColors = {
  red: "#ef6274",
  orange: "#f6a04a",
  yellow: "#edcc3e",
  green: "#4ec67b",
  blue: "#4ba3f9",
  purple: "#a65aeb",
};
type Pin = keyof typeof pinColors;
const labels: Record<Pin, Key> = {
  red: "pinRed",
  orange: "pinOrange",
  yellow: "pinYellow",
  green: "pinGreen",
  blue: "pinBlue",
  purple: "pinPurple",
};
export function NodePins({
  colors,
}: {
  colors?: CreativeNode["data"]["colorPins"];
}) {
  return colors?.length ? (
    <span className={css.nodePins} aria-hidden="true">
      {colors.map((color) => (
        <i key={color} style={{ background: pinColors[color] }} />
      ))}
    </span>
  ) : null;
}
export function PinPicker({
  t,
  colors = [],
  onChange,
}: {
  t(key: Key): string;
  colors?: Pin[];
  onChange(colors: Pin[]): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      portal
      side="top"
      open={open}
      onClose={() => setOpen(false)}
      listClassName={css.pinPalette}
      anchor={
        <Tooltip portal label={t("colorPins")}>
          <Button
            className={css.pinTrigger}
            aria-label={t("colorPins")}
            aria-expanded={open}
            aria-haspopup="menu"
            onClick={() => setOpen(!open)}
          >
            <Tag size={20} />
          </Button>
        </Tooltip>
      }
      items={(Object.keys(pinColors) as Pin[]).map((color) => ({
        id: color,
        label: (
          <span
            className={css.pinSwatch}
            style={{ background: pinColors[color] }}
            data-active={colors.includes(color)}
          >
            <span className={css.srOnly}>{t(labels[color])}</span>
          </span>
        ),
      }))}
      selection="fill"
      selectedIds={colors}
      onSelect={(id) => {
        const color = id as Pin;
        onChange(
          colors.includes(color)
            ? colors.filter((v) => v !== color)
            : [...colors, color],
        );
      }}
    />
  );
}

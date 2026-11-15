import { useState } from "react";
import { Toast } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SharedProps } from "./props.ts";

/** A shell overlay survives leaving the library panel or opening Settings. */
export function LibraryNotifications(p: SharedProps) {
  const notices = p.useCatalog((s) => s.data?.notices ?? []);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const visible = notices.filter(
    (n) => !dismissed.includes(n.id + n.createdAt),
  );
  if (!visible.length) return null;
  const ids = visible.map((n) => n.id);
  return (
    <Toast
      key={visible.map((n) => n.id + n.createdAt).join()}
      text={
        visible.length === 1
          ? visible[0].text
          : visible[0].text +
            ` · ${visible.length} ` +
            p.t("notificationsCount")
      }
      holdMs={5000}
      onDone={() => {
        setDismissed((previous) => [
          ...previous,
          ...visible.map((n) => n.id + n.createdAt),
        ]);
        void p
          .request("acknowledge", { ids })
          .then(p.refresh)
          .catch(() => {});
      }}
    />
  );
}

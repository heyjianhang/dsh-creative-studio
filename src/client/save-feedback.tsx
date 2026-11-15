import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { useState } from "react";
import type { Shared } from "./props.ts";
import css from "./studio.module.css";

export function SaveFeedback({ p, message, conflict }: {
  p: Shared;
  message: string;
  conflict?: boolean;
}) {
  const [reloading, setReloading] = useState(false);
  const downloadDraft = () => {
    const draft = p.editor.current;
    if (!draft) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = draft.name + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <>
      <span>{conflict ? p.t("saveConflict") : message}</span>
      <div className={css.saveFeedbackActions}>
        <Button
          size="sm"
          disabled={reloading}
          onClick={() => {
            if (!conflict) {
              void p.editor.flush().catch(() => {});
              return;
            }
            downloadDraft();
            setReloading(true);
            void p.editor.reload()
              .catch((error: Error) => p.notify(error.message))
              .finally(() => setReloading(false));
          }}
        >
          {p.t(conflict ? "downloadAndReload" : "retry")}
        </Button>
        {!conflict && <Button size="sm" onClick={downloadDraft}>{p.t("exportDraft")}</Button>}
      </div>
    </>
  );
}

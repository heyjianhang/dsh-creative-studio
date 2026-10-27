import { mediaUsageSummary } from "./media-usage.ts";
import { Button, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Generation, MediaJob } from "../shared/contracts.ts";
import type { Key } from "./locales.ts";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";
export type CardJob = (Generation & { kind?: "text" }) | MediaJob;
export const jobActive = (job: CardJob) =>
  ["queued", "running", "downloading"].includes(job.status);
export function latestBatch(jobs: CardJob[], nodeId: string) {
  const own = jobs.filter((j) => j.nodeId === nodeId),
    batch = own.at(-1)?.batchId;
  if (!batch) return [];
  const indexed = new Map<number, CardJob>();
  own
    .filter((j) => j.batchId === batch)
    .forEach((j) => indexed.set(j.index, j));
  return [...indexed.values()].sort((a, b) => a.index - b.index);
}
export function GenerationCard({
  jobs,
  t,
  action,
}: {
  jobs: CardJob[];
  t: (key: Key) => string;
  action: (job: CardJob, action: "cancel" | "retry" | "configure") => void;
}) {
  if (!jobs.length) return null;
  return (
    <div
      className={css.cardGeneration + " nodrag nopan nowheel"}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {jobs.map((j) => {
        const configError =
          "kind" in j &&
          j.kind !== "text" &&
          (("failure" in j &&
            ["authentication", "configuration", "permission"].includes(
              j.failure?.kind ?? "",
            )) ||
            /AuthenticationError|InvalidEndpointOrModel|ModelNotOpen/.test(
              j.error ?? "",
            ));
        return (
          <div key={j.id} className={css.cardJob} data-status={j.status}>
            <div className={css.cardJobLine}>
              <span>
                {jobActive(j) && <i className={css.cardSpinner} />}{" "}
                {jobs.length > 1 ? `${j.index + 1} · ` : ""}
                {"stage" in j && j.stage
                  ? j.stage
                  : t(`generation_${j.status}` as Key)}
              </span>
              {jobActive(j) ? (
                <Tooltip label={t("stop")} portal>
                  <Button
                    size="sm"
                    aria-label={t("stop")}
                    onClick={() => action(j, "cancel")}
                  >
                    <Icon name="stop" size={14} />
                  </Button>
                </Tooltip>
              ) : configError ? (
                <Button size="sm" onClick={() => action(j, "configure")}>
                  {t("checkMediaSettings")}
                </Button>
              ) : ["failed", "cancelled"].includes(j.status) ? (
                <Button size="sm" onClick={() => action(j, "retry")}>
                  {t(
                    ("remoteId" in j && j.remoteId) ||
                      ("resultUrl" in j && j.resultUrl)
                      ? "continueResult"
                      : "retry",
                  )}
                </Button>
              ) : null}
            </div>
            {j.error && <small role="alert">{j.error}</small>}
            {"failure" in j && j.failure?.requestId && (
              <small>Request ID: {j.failure.requestId}</small>
            )}
            {"usage" in j && j.usage && mediaUsageSummary(j.usage, t) && (
              <small>{mediaUsageSummary(j.usage, t)}</small>
            )}
            {"estimate" in j && j.estimate && (
              <small>
                {t("estimatedCost")} {j.estimate.currency}{" "}
                {j.estimate.amount.toFixed(3)}
              </small>
            )}
          </div>
        );
      })}
    </div>
  );
}

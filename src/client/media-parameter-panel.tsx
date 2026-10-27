import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { Rectangle } from "@phosphor-icons/react/dist/csr/Rectangle";
import { Square } from "@phosphor-icons/react/dist/csr/Square";
import { CornersOut } from "@phosphor-icons/react/dist/csr/CornersOut";
import type {
  MediaParameters,
  capabilities,
} from "../shared/media-contracts.ts";
import type { Shared } from "./props.ts";
import css from "./studio.module.css";

export function AspectIcon({
  ratio,
  size = 20,
}: {
  ratio: string;
  size?: number;
}) {
  if (ratio === "adaptive") return <CornersOut size={size} />;
  if (ratio === "1:1") return <Square size={size} />;
  const [width, height] = ratio.split(":").map(Number);
  return (
    <Rectangle
      size={size}
      style={{ transform: width < height ? "rotate(90deg)" : undefined }}
    />
  );
}

export function MediaParameterPanel({
  p,
  cap,
  value,
  hasFrames,
  onChange,
}: {
  p: Shared;
  cap: ReturnType<typeof capabilities>;
  value: MediaParameters;
  hasFrames: boolean;
  onChange(value: MediaParameters): void;
}) {
  const change = (patch: Partial<MediaParameters>) =>
    onChange({ ...value, ...patch });
  const options = (
    label: string,
    items: { value: string; label: string }[],
    current: string,
    select: (id: string) => void,
    compact = false,
  ) => (
    <div
      className={compact ? css.durationOptions : css.parameterSegments}
      role="radiogroup"
      aria-label={label}
    >
      {items.map((item) => (
        <Button
          key={item.value}
          role="radio"
          aria-checked={item.value === current}
          data-active={item.value === current}
          onClick={() => select(item.value)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
  return (
    <div className={css.mediaParameterBody}>
      {cap.kind === "video" && (
        <section>
          <h4>{p.t("generateMode")}</h4>
          {options(
            p.t("generateMode"),
            cap.modes.map((mode) => ({
              value: mode,
              label: p.t(mode === "frames" ? "modeFrames" : "modeReference"),
            })),
            value.mode,
            (mode) => change({ mode: mode as MediaParameters["mode"] }),
          )}
        </section>
      )}
      <section>
        <h4>{p.t("aspectRatio")}</h4>
        <div
          className={css.aspectOptions}
          role="radiogroup"
          aria-label={p.t("aspectRatio")}
        >
          {(cap.framesAdaptive && value.mode === "frames" && hasFrames
            ? ["adaptive"]
            : cap.ratios
          ).map((ratio) => (
            <Button
              key={ratio}
              role="radio"
              aria-checked={ratio === value.ratio}
              data-active={ratio === value.ratio}
              onClick={() => change({ ratio })}
            >
              <AspectIcon ratio={ratio} />
              <span>{ratio === "adaptive" ? p.t("adaptive") : ratio}</span>
            </Button>
          ))}
        </div>
      </section>
      <section>
        <h4>{p.t("resolution")}</h4>
        {options(
          p.t("resolution"),
          cap.resolutions.map((resolution) => ({
            value: resolution,
            label: resolution,
          })),
          value.resolution,
          (resolution) => change({ resolution }),
        )}
      </section>
      {cap.kind === "video" && (
        <section>
          <h4>{p.t("duration")}</h4>
          {options(
            p.t("duration"),
            cap.durations.map((duration) => ({
              value: String(duration),
              label: `${duration}s`,
            })),
            String(value.duration),
            (duration) => change({ duration: Number(duration) }),
            true,
          )}
        </section>
      )}
      {cap.audio && (
        <section>
          <h4>{p.t("generateAudio")}</h4>
          {options(
            p.t("generateAudio"),
            [
              { value: "true", label: p.t("audioOn") },
              { value: "false", label: p.t("audioOff") },
            ],
            String(value.audio),
            (audio) => change({ audio: audio === "true" }),
          )}
        </section>
      )}
    </div>
  );
}

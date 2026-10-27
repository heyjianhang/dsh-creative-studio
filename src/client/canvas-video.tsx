import { useEffect, useRef, useState, type ReactEventHandler } from "react";
import { Button, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Key } from "./locales.ts";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";
import { SpeakerHigh } from "@phosphor-icons/react/dist/csr/SpeakerHigh";
import { SpeakerSlash } from "@phosphor-icons/react/dist/csr/SpeakerSlash";

function time(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

// The video is a drag surface. Only its controls opt out of node dragging;
// wheel events remain available to React Flow, including over the controls.
export function CanvasVideo({
  src,
  t,
  onLoadedMetadata,
  muted = true,
  onMutedChange,
  onExpand,
}: {
  src: string;
  t(key: Key): string;
  onLoadedMetadata: ReactEventHandler<HTMLVideoElement>;
  muted?: boolean;
  onMutedChange?(muted: boolean): void;
  onExpand?(position: number): void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const pointer = useRef({ x: 0, y: 0, dragged: false });
  const playTimer = useRef<ReturnType<typeof setTimeout>>();
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    setPlaying(false);
    setPosition(0);
    setDuration(0);
    setError(false);
    return () => clearTimeout(playTimer.current);
  }, [src]);
  const toggle = () => {
    const player = video.current;
    if (!player) return;
    setError(false);
    if (player.paused) void player.play().catch(() => setError(true));
    else player.pause();
  };
  const updateDuration: ReactEventHandler<HTMLVideoElement> = (e) => {
    const value = e.currentTarget.duration;
    setDuration(Number.isFinite(value) ? value : 0);
  };
  return (
    <div
      className={css.canvasVideo}
      data-playing={playing}
      onPointerDownCapture={(e) => {
        pointer.current = { x: e.clientX, y: e.clientY, dragged: false };
      }}
      onPointerMoveCapture={(e) => {
        if (
          Math.hypot(
            e.clientX - pointer.current.x,
            e.clientY - pointer.current.y,
          ) > 5
        )
          pointer.current.dragged = true;
      }}
      onClick={(e) => {
        if (e.shiftKey || pointer.current.dragged) return;
        clearTimeout(playTimer.current);
        if (e.detail === 1) playTimer.current = setTimeout(toggle, 230);
      }}
      onDoubleClickCapture={() => clearTimeout(playTimer.current)}
    >
      <video
        ref={video}
        src={src}
        playsInline
        preload="metadata"
        tabIndex={-1}
        draggable={false}
        muted={muted}
        onLoadedMetadata={(e) => {
          updateDuration(e);
          onLoadedMetadata(e);
        }}
        onDurationChange={updateDuration}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setError(true)}
      />
      <div
        className={`${css.canvasVideoSound} nodrag nopan`}
        data-studio-player
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Tooltip label={t(muted ? "unmuteVideo" : "muteVideo")} portal>
          <Button
            aria-label={t(muted ? "unmuteVideo" : "muteVideo")}
            aria-pressed={!muted}
            onClick={() => onMutedChange?.(!muted)}
          >
            {muted ? <SpeakerSlash size={19} /> : <SpeakerHigh size={19} />}
          </Button>
        </Tooltip>
      </div>
      {!playing && !error && (
        <span className={css.canvasVideoCenter} aria-hidden>
          <Icon name="play" size={24} />
        </span>
      )}
      <div
        className={`${css.canvasVideoControls} nodrag nopan`}
        data-studio-player
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Tooltip
          label={t(playing ? "pauseVideo" : "playVideo")}
          side="top"
          portal
        >
          <Button
            className={css.canvasVideoPlay}
            aria-label={t(playing ? "pauseVideo" : "playVideo")}
            onClick={toggle}
          >
            <Icon name={playing ? "pause" : "play"} size={15} />
          </Button>
        </Tooltip>
        <span className={css.canvasVideoTime}>{time(position)}</span>
        <input
          type="range"
          className={css.canvasVideoSeek}
          min={0}
          max={duration || 1}
          step={0.01}
          value={Math.min(position, duration)}
          disabled={!duration}
          aria-label={t("videoProgress")}
          aria-valuetext={`${time(position)} / ${time(duration)}`}
          onChange={(e) => {
            const player = video.current;
            if (!player || !duration) return;
            player.currentTime = Number(e.target.value);
            setPosition(player.currentTime);
          }}
        />
        <span className={css.canvasVideoTime}>{time(duration)}</span>
        {onExpand && (
          <Tooltip label={t("previewTitle")} portal>
            <Button
              className={css.canvasVideoPlay}
              aria-label={t("previewTitle")}
              onClick={() => {
                video.current?.pause();
                onExpand(video.current?.currentTime ?? position);
              }}
            >
              <Icon name="fit" size={17} />
            </Button>
          </Tooltip>
        )}
      </div>
      {error && (
        <span className={css.canvasVideoError} role="alert">
          {t("videoPlaybackFailed")}
        </span>
      )}
    </div>
  );
}

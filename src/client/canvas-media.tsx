import { useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { MediaView } from "./media.tsx";
import css from "./studio.module.css";

/** Keep visited media mounted; only delay the first read of distant nodes. */
export function CanvasMedia(props: ComponentProps<typeof MediaView>) {
  const anchor = useRef<HTMLDivElement>(null);
  const [visited, setVisited] = useState(false);
  useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisited(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisited(true);
        else element.querySelector("video")?.pause();
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={anchor} className={css.nodeMedia}>
      {visited ? (
        <MediaView {...props} />
      ) : (
        <div className={css.mediaPlaceholder} />
      )}
    </div>
  );
}

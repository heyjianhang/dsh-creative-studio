import { useEffect, useRef, useState } from "react";
import type { MediaJob } from "../shared/contracts.ts";
import type { Shared } from "./props.ts";
export function useMediaJobs(p: Shared, projectId: string) {
  const [jobs, setJobs] = useState<MediaJob[]>([]),
    [error, setError] = useState("");
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let active = true,
      busy = false;
    const c = new AbortController();
    const poll = async () => {
      if (!active || busy) return;
      busy = true;
      try {
        const rows = await p.request("mediaJobs", { projectId }, c.signal);
        if (!active) return;
        setJobs((previous) =>
          JSON.stringify(previous) === JSON.stringify(rows) ? previous : rows,
        );
        if (active)
          setError(
            rows.find((job) => job.status === "completed" && !job.applied)
              ?.error ?? "",
          );
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        busy = false;
      }
    };
    refresh.current = poll;
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      c.abort();
      clearInterval(timer);
    };
  }, [projectId, p.request, p.editor]);
  return { jobs, error, refresh: () => refresh.current() };
}

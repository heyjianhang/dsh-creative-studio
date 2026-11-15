import { useEffect, useRef, useState } from "react";
import type { Generation } from "../shared/contracts.ts";
import type { Shared } from "./props.ts";

export function useTextJobs(p: Shared, projectId: string) {
  const [jobs, setJobs] = useState<Generation[]>([]);
  const [error, setError] = useState("");
  const refresh = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let active = true,
      busy = false;
    const controller = new AbortController();
    const poll = async () => {
      if (!active || busy) return;
      busy = true;
      try {
        const rows = await p.request(
          "generations",
          { projectId },
          controller.signal,
        );
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
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        busy = false;
      }
    };
    refresh.current = poll;
    void poll();
    const timer = setInterval(() => void poll(), 800);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [projectId, p.editor, p.request]);
  return { jobs, error, refresh: () => refresh.current() };
}

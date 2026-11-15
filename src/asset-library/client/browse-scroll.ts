import { useLayoutEffect, useRef, type RefObject } from "react";

/** Restore the last browsing position after search results finish being replaced. */
export function useBrowseScroll<T extends HTMLElement>(
  element: RefObject<T>,
  scope: string,
  searching: boolean,
  ready: boolean,
) {
  const saved = useRef(0);
  const previous = useRef({ scope, searching });
  const pending = useRef<number>();
  useLayoutEffect(() => {
    if (previous.current.scope !== scope) {
      saved.current = 0;
      pending.current = 0;
    } else if (previous.current.searching !== searching) {
      pending.current = searching ? 0 : saved.current;
    }
    previous.current = { scope, searching };
    if (ready && pending.current !== undefined && element.current) {
      element.current.scrollTop = pending.current;
      pending.current = undefined;
    }
  }, [scope, searching, ready]);
  return () => {
    if (!searching && ready && pending.current === undefined && element.current)
      saved.current = element.current.scrollTop;
  };
}

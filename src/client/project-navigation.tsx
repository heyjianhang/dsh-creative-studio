import { useEffect, useRef, useState } from "react";
import { Button, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Shared } from "./props.ts";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";

/** Display the project name and return to the list after pending edits are saved.
 * @param p Shared project state and save-aware navigation.
 * @returns Project title and a single back action.
 */
export function ProjectNavigation(p: Shared) {
  const project = p.useStudio((s) => s.current)!;
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const back = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      await p.navigate("projects");
    } catch (error) {
      if (alive.current)
        p.notify(error instanceof Error ? error.message : String(error));
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  };
  return (
    <div className={css.projectNavigation}>
      <Tooltip label={p.t("returnProjects")} portal>
        <Button
          size="sm"
          className={css.projectBack}
          disabled={pending}
          aria-label={p.t("returnProjects")}
          onClick={() => void back()}
        >
          <Icon name="back" size={18} />
        </Button>
      </Tooltip>
      <span className={css.projectTitle} title={project.name}>
        {project.name}
      </span>
    </div>
  );
}

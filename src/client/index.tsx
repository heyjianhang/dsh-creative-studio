import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type {
  PropsRuntime,
  PropsRenderFactories,
} from "@deepseek-ai/dsh-client-ui-slots";
import type { ConversationViewsProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import {
  IconSparkleRegular,
  Toast,
} from "@deepseek-ai/dsh-client-ui-primitives";
import {
  contribution,
  type Method,
  type Input,
  type Project,
  projectSchema,
} from "../shared/contracts.ts";
import { disposeMediaSession } from "./media-source.ts";
import { Editor } from "./editor.ts";
import type { Injected, Request, Shared, State } from "./props.ts";
import { Page, StudioSurface, Settings } from "./views.tsx";
import { zh, en } from "./locales.ts";
import css, { cssText } from "./studio.module.css";
import flowCSS from "@xyflow/react/dist/base.css";
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "creative.agent": { kind: "single"; scope: "session" };
  }
}
declare module "@deepseek-ai/dsh-api-session-controller/client" {
  interface SessionReferenceSourceMap {
    creativeStudio: unknown;
  }
}
export const inject = ["slots", "layout", "locale", "remote", "sessions"];
const PANEL = "creative-studio" as MainPanelId;
function FixedChat(p: ConversationViewsProps) {
  return (
    <div className={css.agentViews}>
      {p.renderSlot("conversation.session", { view: "chat" })}
    </div>
  );
}
function Agent(p: PropsRuntime<"creative.agent"> & PropsRenderFactories) {
  const session = p.useSession((s) => s);
  return p.renderFactorySlot(
    "conversation.content",
    {
      variant: "embedded",
      phase: session.openState === "loading" ? "settling" : "active",
      hero: false,
    },
    { slots: { views: FixedChat } },
  );
}
function Notices(p: Shared) {
  const text = p.useStudio((s) => s.notice);
  return text ? (
    <Toast key={text} text={text} holdMs={4500} onDone={() => p.notify("")} />
  ) : null;
}
export async function apply(ctx: Context) {
  try {
    ctx.effect(() => ctx.locale.register("creative-studio", { zh, en }));
    ctx.effect(() => {
      const el = document.createElement("style");
      el.dataset.plugin = "dsh-creative-studio";
      el.textContent = flowCSS + "\n" + cssText;
      document.head.append(el);
      return () => el.remove();
    });
    await ctx.remote.$mount(contribution);
    ctx.inject(["remote.creativeStudio"], (ctx) => {
      try {
        const abort = new AbortController();
        const store = createSnapshotStore<State>({
          page: "projects",
          projects: [],
          status: "saved",
          canUndo: false,
          canRedo: false,
        });
        const request: Request = async <K extends Method>(
          method: K,
          input: Input<K>,
          signal?: AbortSignal,
        ) => {
          const call = ctx.remote.creativeStudio[method] as any;
          const r = await call(
            input,
            signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
          );
          if (!r.ok) throw r.error;
          return r.value;
        };
        const draftKey = "dsh.creative-studio.draft";
        const editor = new Editor(
          (p) => request("save", { project: p }),
          () => {
            store.set({
              ...store.getSnapshot(),
              current: editor.current,
              status: editor.status,
              error: editor.error,
              canUndo: editor.canUndo,
              canRedo: editor.canRedo,
            });
          },
          (p) => {
            try {
              if (p) localStorage.setItem(draftKey, JSON.stringify(p));
              else localStorage.removeItem(draftKey);
            } catch {
              store.set({
                ...store.getSnapshot(),
                notice: ctx.locale.bind("creative-studio")("unsaved"),
              });
            }
          },
        );
        const refresh = async () => {
          const [projects, capabilities] = await Promise.all([
            request("list", {}),
            request("capabilities", {}),
          ]);
          store.set({ ...store.getSnapshot(), projects, capabilities });
        };
        const openProject = async (id: string) => {
          await editor.flush();
          let p = await request("get", { id });
          try {
            const draft = projectSchema.safeParse(
              JSON.parse(localStorage.getItem(draftKey) ?? "null"),
            );
            if (draft.success && draft.data.id === id) {
              if (draft.data.revision === p.revision) {
                editor.load(p);
                editor.change(draft.data);
                return;
              }
              store.set({
                ...store.getSnapshot(),
                notice: ctx.locale.bind("creative-studio")("recover"),
              });
            }
          } catch {}
          editor.load(p);
        };
        const createProject = async (name: string) => {
          await editor.flush();
          const p = await request("create", { name });
          await refresh();
          editor.load(p);
        };
        const navigate = async (page: State["page"]) => {
          await editor.flush();
          editor.current = undefined;
          store.set({
            ...store.getSnapshot(),
            page,
            current: undefined,
            error: "",
          });
          await refresh();
        };
        const sessionStarts = new Map<string, Promise<SessionId>>();
        const resolveSession = (projectId: string) => {
          let pending = sessionStarts.get(projectId);
          if (!pending) {
            pending = (async () => {
              const info = await request("session", { projectId });
              if (info.sessionId) return info.sessionId as SessionId;
              const id = await ctx.sessions.create({ cwd: info.cwd });
              await request("session", { projectId, sessionId: id });
              return id;
            })();
            sessionStarts.set(projectId, pending);
            void pending
              .finally(() => sessionStarts.delete(projectId))
              .catch(() => {});
          }
          return pending;
        };
        const injected = (): Injected => ({
          hooks: { studio: store },
          focusNode: (id: string) =>
            store.set({ ...store.getSnapshot(), focusNodeId: id }),
          request,
          editor,
          refresh,
          navigate,
          openProject,
          createProject,
          notify: (notice) => store.set({ ...store.getSnapshot(), notice }),
          retainAgent: async (projectId) => {
            const sessionId = await resolveSession(projectId);
            const reference = ctx.sessions.retain(sessionId, {
              source: "creativeStudio",
            });
            try {
              await reference.ready;
              return reference;
            } catch (e) {
              reference.release();
              throw e;
            }
          },
        });
        ctx.slots.inject("main", () =>
          ctx.slots.register(
            {
              name: "main",
              key: PANEL,
              locale: "creative-studio",
              inject: injected,
            },
            Page,
          ),
        );
        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register(
            {
              name: "shell.overlay",
              id: "creative-studio.surface",
              locale: "creative-studio",
              inject: injected,
              children: {
                "creative.agent": { kind: "single", scope: "session" },
              },
            },
            StudioSurface,
          ),
        );
        ctx.slots.inject("creative.agent", () =>
          ctx.slots.register({ name: "creative.agent" }, Agent),
        );
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL,
              order: 16,
              locale: "creative-studio",
              label: () => ctx.locale.bind("creative-studio")("title"),
            },
            () => <IconSparkleRegular size={20} />,
          ),
        );
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: PANEL,
              order: 61,
              label: () => ctx.locale.bind("creative-studio")("title"),
              locale: "creative-studio",
              inject: injected,
            },
            Settings,
          ),
        );
        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register(
            {
              name: "shell.overlay",
              id: "creative-studio.notices",
              locale: "creative-studio",
              inject: injected,
            },
            Notices,
          ),
        );
        void refresh().catch((e) =>
          store.set({ ...store.getSnapshot(), error: e.message }),
        );
        let reading = false;
        const timer = setInterval(() => {
          if (
            reading ||
            editor.dirty ||
            !editor.current ||
            ctx.layout.panelInfo.getSnapshot().activePanelId !== PANEL
          )
            return;
          reading = true;
          const id = editor.current.id;
          void request("get", { id })
            .then((p) => {
              if (
                editor.current?.id === id &&
                !editor.dirty &&
                p.revision !== editor.current.revision
              )
                editor.load(p);
            })
            .catch(() => {})
            .finally(() => {
              reading = false;
            });
        }, 1800);
        const unload = (e: BeforeUnloadEvent) => {
          if (editor.dirty) {
            e.preventDefault();
            e.returnValue = "";
          }
        };
        window.addEventListener("beforeunload", unload);
        ctx.effect(() => () => {
          editor.dispose();
          clearInterval(timer);
          window.removeEventListener("beforeunload", unload);
          abort.abort();
          disposeMediaSession(request);
          if (ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL)
            ctx.layout.selectPanel(null);
        });
      } catch (error) {
        console.error("creative-studio initialization", error);
        throw error;
      }
    });
  } catch (error) {
    console.error("creative-studio mount", error);
    throw error;
  }
}

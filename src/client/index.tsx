import type {} from "@actvero/dsh-capability-ui/client/contracts";
import type {
  WorkbenchBodyProps,
  WorkbenchHeaderProps,
} from "@actvero/dsh-capability-ui/client/contracts";
import { useEffect, useSyncExternalStore } from "react";
import manifest from "../../package.json";
import metadata from "../../workbench.json";
import { WorkbenchHeader } from "./workbench-header.tsx";
import * as assetLibrary from "../asset-library/client/index.tsx";
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
import { Page, Settings } from "./views.tsx";
import { zh, en } from "./locales.ts";
import css, { cssText } from "./studio.module.css";
import { cssText as collectionCSS } from "./collection.module.css";
import flowCSS from "@xyflow/react/dist/base.css";
import canvasPreview from "../../assets/workbench-canvas.jpg";
import assetsPreview from "../../assets/workbench-assets.jpg";
import templatesPreview from "../../assets/workbench-templates.jpg";
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {}
}
declare module "@deepseek-ai/dsh-api-session-controller/client" {
  interface SessionReferenceSourceMap {
    creativeStudio: unknown;
  }
}
export const inject = [
  "slots",
  "layout",
  "locale",
  "remote",
  "sessions",
  "actveroWorkbenches",
];
const PANEL = "creative-studio" as MainPanelId;
function Notices(p: Shared) {
  const text = p.useStudio((s) => s.notice);
  return text ? (
    <Toast key={text} text={text} holdMs={4500} onDone={() => p.notify("")} />
  ) : null;
}
export async function apply(ctx: Context) {
  const libraryViews = createSnapshotStore<Partial<assetLibrary.LibraryViews>>(
    {},
  );
  ctx.plugin(assetLibrary, {
    bindViews: (views: assetLibrary.LibraryViews) => {
      libraryViews.set(views);
      return () => libraryViews.set({});
    },
  });
  const useLibraryViews = () =>
    useSyncExternalStore(libraryViews.subscribe, libraryViews.getSnapshot);
  function Library() {
    const { Workspace } = useLibraryViews();
    return Workspace ? <Workspace /> : null;
  }
  try {
    ctx.effect(() => ctx.locale.register("creative-studio", { zh, en }));
    ctx.effect(() => {
      const el = document.createElement("style");
      el.dataset.plugin = "dsh-creative-studio";
      el.textContent = flowCSS + "\n" + cssText + "\n" + collectionCSS;
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
              conflict: editor.conflict,
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
          (id) => request("get", { id }),
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
          const project = await request("get", { id });
          editor.load(project);
          try {
            const draft = projectSchema.safeParse(
              JSON.parse(localStorage.getItem(draftKey) ?? "null"),
            );
            if (draft.success) editor.restoreDraft(draft.data);
          } catch (_error) {
            // An unreadable browser draft does not prevent opening the saved project.
          }
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
        const injected = (): Injected => ({
          hooks: { studio: store },
          renderLibrary: () => <Library />,
          focusNode: (id: string) =>
            store.set({ ...store.getSnapshot(), focusNodeId: id }),
          request,
          editor,
          refresh,
          navigate,
          openProject,
          createProject,
          notify: (notice) => store.set({ ...store.getSnapshot(), notice }),
          openSettings: () =>
            ctx.actveroWorkbenches.openSettings(manifest.name),
        });
        const shared = () => ({
          ...injected(),
          t: ctx.locale.bind("creative-studio"),
          useStudio: <T,>(selector: (state: State) => T) =>
            selector(useSyncExternalStore(store.subscribe, store.getSnapshot)),
        });
        let restoredConversation: string | null = null;
        let restoredLocation: WorkbenchBodyProps["workbench"]["location"] =
          null;
        function Body(p: WorkbenchBodyProps) {
          const target =
            p.workbench.location?.objectId ?? p.workbench.object?.id;
          useEffect(() => {
            const locationChanged =
              !!p.workbench.location &&
              restoredLocation !== p.workbench.location;
            const conversationChanged =
              !!p.workbench.sessionId &&
              restoredConversation !== p.workbench.sessionId;
            restoredLocation = p.workbench.location;
            restoredConversation = p.workbench.sessionId;
            if (
              (locationChanged || conversationChanged) &&
              target &&
              editor.current?.id !== target
            )
              void openProject(target).catch((error) =>
                injected().notify(error.message),
              );
          }, [target, p.workbench.location, p.workbench.sessionId]);
          return <Page {...p} {...shared()} workbench={p.workbench} />;
        }
        function Header(p: WorkbenchHeaderProps) {
          return <WorkbenchHeader {...p} {...shared()} />;
        }
        function WorkbenchSettings() {
          const { Settings: LibrarySettings } = useLibraryViews();
          return <Settings {...shared()} LibrarySettings={LibrarySettings} />;
        }
        ctx.effect(() =>
          ctx.actveroWorkbenches.register(
            {
              ...metadata,
              id: manifest.name,
              version: manifest.version,
              previewUrls: [canvasPreview, assetsPreview, templatesPreview],
              display: { sidebar: "focus", ai: "hide" },
              author: "本地开发",
              tags: ["创作", "素材", "画布"],
            },
            Body,
            {
              header: Header,
              catalogButton: "hide",
              conversationTarget: async () => {
                const id = editor.current?.id;
                await editor.flush();
                return id
                  ? (id as import("@actvero/dsh-capability-ui/client/contracts").WorkbenchObjectId)
                  : null;
              },
              objectNavigation: true,
              settings: { component: WorkbenchSettings },
            },
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
            ctx.layout.panelInfo.getSnapshot().activePanelId !==
              "actvero-workbench-business"
          )
            return;
          reading = true;
          const id = editor.current.id;
          void request("get", { id })
            .then((p) => {
              if (
                editor.current?.id === id &&
                !editor.dirty &&
                p.revision > editor.current.revision
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

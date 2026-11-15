import { useSyncExternalStore, type ComponentType } from "react";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import {
  contribution,
  type Input,
  type Method,
  type Output,
} from "../shared/contracts.ts";
import { zh, en } from "./locales.ts";
import { Workspace } from "./views.tsx";
import { LibraryNotifications } from "./notifications.tsx";
import { SettingsPage } from "./settings.tsx";
import { createViewStore } from "./view-store.ts";
import type {
  Catalog,
  Injected,
  LibrarySettingsNavigation,
  Request,
  SharedProps,
} from "./props.ts";
import { cssText } from "./library.module.css";
import { cssText as folderBrowserCSS } from "./folder-browser.module.css";
import { AssetEditor, type EditorSnapshot } from "./asset-editor.ts";
// DSH 0.2.1-rc.3 publishes this native picker without remote namespace typings.
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    directoryPicker: { pick(): Promise<RemoteResult<string | null>> };
  }
}
export const inject = ["slots", "layout", "locale", "remote"];
const PANEL = "creative-studio" as MainPanelId;
/** Asset library views mounted by the creative workbench. */
export type LibraryViews = {
  Workspace: ComponentType;
  Settings: ComponentType<LibrarySettingsNavigation>;
};
export async function apply(
  ctx: Context,
  config: { bindViews?: (views: LibraryViews) => () => void } = {},
) {
  ctx.effect(() => ctx.locale.register("asset-library", { zh, en }));
  ctx.effect(() => {
    const s = document.createElement("style");
    s.dataset.plugin = "dsh-asset-library";
    s.textContent = cssText + "\n" + folderBrowserCSS;
    document.head.append(s);
    return () => s.remove();
  });
  await ctx.remote.$mount(contribution);
  ctx.inject(["remote.assetLibrary"], (ctx) => {
    const store = createViewStore().create(),
      catalog = createSnapshotStore<Catalog>({}),
      edits = createSnapshotStore<EditorSnapshot>({});
    let ended = false,
      reading = false,
      previous: MainPanelId | null =
        ctx.layout.panelInfo.getSnapshot().activePanelId;
    const abort = new AbortController();
    const request: Request = async <K extends Method>(
      method: K,
      input: Input<K>,
      signal?: AbortSignal,
    ) => {
      if (method === "library") {
        const operation = input as Input<"library">;
        if (operation.action === "close") {
          await editor.flushAll();
          if (
            Object.values(edits.getSnapshot()).some(
              (edit) =>
                edit.target.libraryId === operation.id &&
                edit.status === "error",
            )
          )
            throw new Error(
              "\u8fd8\u6709\u4fee\u6539\u672a\u4fdd\u5b58\uff0c\u8bf7\u5148\u91cd\u8bd5\u540e\u518d\u5173\u95ed\u7d20\u6750\u5e93",
            );
        }
      }
      if (
        method === "collection" &&
        (input as Input<"collection">).action === "delete"
      ) {
        await editor.flushAll();
        const libraryId = (input as Input<"collection">).libraryId;
        if (
          Object.values(edits.getSnapshot()).some(
            (edit) =>
              edit.target.libraryId === libraryId && edit.status === "error",
          )
        )
          throw new Error(
            ctx.locale.bind("asset-library")("deletePendingEdits"),
          );
      }
      const call = ctx.remote.assetLibrary[method] as (
        request: Input<K>,
        signal?: AbortSignal,
      ) => Promise<
        { ok: true; value: Output<K> } | { ok: false; error: Error }
      >;
      const result = await call(
        input,
        signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
      );
      if (!result.ok) throw result.error;
      return result.value;
    };
    const readCatalog = async (force = false) => {
      if (ended || reading) return;
      reading = true;
      try {
        const data = await request("snapshot", {});
        if (
          !ended &&
          (force ||
            catalog.getSnapshot().error ||
            JSON.stringify(catalog.getSnapshot().data) !== JSON.stringify(data))
        )
          catalog.set({
            data,
            revision: (catalog.getSnapshot().revision ?? 0) + 1,
          });
      } catch (e) {
        if (!ended)
          catalog.set({
            ...catalog.getSnapshot(),
            error: e instanceof Error ? e.message : zh.error,
          });
      } finally {
        reading = false;
      }
    };
    const refresh = () => readCatalog(true);
    const draftKey = "dsh.asset-library.pending-edits";
    const editor = new AssetEditor({
      write: async (target, patch) => {
        if (
          patch.tags &&
          (patch.tags.length > 50 || patch.tags.some((tag) => tag.length > 80))
        )
          throw new Error(
            "\u6807\u7b7e\u6700\u591a 50 \u4e2a\uff0c\u6bcf\u4e2a\u6807\u7b7e\u6700\u591a 80 \u4e2a\u5b57\u7b26\uff0c\u8bf7\u7f29\u77ed\u540e\u91cd\u8bd5\u3002",
          );
        if (patch.notes && patch.notes.length > 10000)
          throw new Error(
            "\u5907\u6ce8\u6700\u591a 10000 \u4e2a\u5b57\u7b26\uff0c\u8bf7\u7f29\u77ed\u540e\u91cd\u8bd5\u3002",
          );
        if (patch.collectionIds && patch.collectionIds.length > 100)
          throw new Error(
            "\u4e00\u4e2a\u7d20\u6750\u6700\u591a\u52a0\u5165 100 \u4e2a\u6536\u85cf\u5939\uff0c\u8bf7\u51cf\u5c11\u5df2\u9009\u9879\u3002",
          );
        return request("editAsset", {
          libraryId: target.libraryId,
          id: target.id,
          ...patch,
        });
      },
      publish: (value) => edits.set(value),
      refresh,
      persist: (value) => {
        if (value.length) localStorage.setItem(draftKey, JSON.stringify(value));
        else localStorage.removeItem(draftKey);
      },
    });
    try {
      const pending = JSON.parse(localStorage.getItem(draftKey) ?? "[]");
      if (Array.isArray(pending)) editor.restore(pending);
    } catch {
      /* A malformed browser draft must not stop the plugin. */
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (editor.hasPending()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    ctx.effect(() => () => {
      editor.dispose();
      window.removeEventListener("beforeunload", beforeUnload);
    });
    const back = () => {
      try {
        ctx.layout.selectPanel(previous === PANEL ? null : previous);
      } catch {
        ctx.layout.selectPanel(null);
      }
    };
    let chooseDirectory: (() => Promise<string | undefined>) | undefined;
    ctx.inject(["remote.directoryPicker"], (pickerCtx) => {
      chooseDirectory = async () => {
        const result = await pickerCtx.remote.directoryPicker.pick();
        if (!result.ok) throw result.error;
        return result.value ?? undefined;
      };
      return () => {
        chooseDirectory = undefined;
      };
    });
    const injected = (): Injected => ({
      hooks: { catalog, edits },
      editAsset: (target, patch, immediate) =>
        editor.stage(target, patch, immediate),
      flushEdits: (key) =>
        key ? editor.flush(key) : editor.flushAll().then(() => {}),
      request,
      refresh,
      onBack: back,
      onToggle: () => ctx.layout.toggleSidebar(),
      openLibraryPanel: () => ctx.layout.selectPanel(PANEL),
      pickDirectory: async () => {
        if (!chooseDirectory)
          throw new Error(ctx.locale.bind("asset-library")("folderHint"));
        return chooseDirectory();
      },
    });
    const viewProps = (): SharedProps => ({
      ...injected(),
      t: ctx.locale.bind("asset-library"),
      actions: store.actions,
      useStore: (selector) =>
        selector(useSyncExternalStore(store.subscribe, store.getSnapshot)),
      useCatalog: (selector) =>
        selector(useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)),
      useEdits: (selector) =>
        selector(useSyncExternalStore(edits.subscribe, edits.getSnapshot)),
    });
    if (config.bindViews) {
      const dispose = config.bindViews({
        Workspace: () => <Workspace {...viewProps()} />,
        Settings: (navigation) => (
          <SettingsPage {...viewProps()} {...navigation} />
        ),
      });
      ctx.effect(() => dispose);
    }
    ctx.slots.inject("shell.overlay", () =>
      ctx.slots.register(
        {
          name: "shell.overlay",
          id: "asset-library.notifications",
          locale: "asset-library",
          inject: injected,
        },
        () => <LibraryNotifications {...viewProps()} />,
      ),
    );
    void refresh();
    const timer = setInterval(() => {
      void readCatalog();
    }, 1500);
    ctx.effect(() => () => {
      ended = true;
      abort.abort();
      clearInterval(timer);
      if (ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL) back();
    });
  });
}

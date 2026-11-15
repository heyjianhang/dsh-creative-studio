import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRuntime,
  PropsStore,
} from "@deepseek-ai/dsh-client-ui-slots";
import type { createViewStore } from "./view-store.ts";
import type { Snapshot, Method, Input, Output } from "../shared/contracts.ts";
import type { EditorSnapshot, EditTarget, AssetPatch } from "./asset-editor.ts";
export type Catalog = { data?: Snapshot; error?: string; revision?: number };
export type Request = <K extends Method>(
  method: K,
  request: Input<K>,
  signal?: AbortSignal,
) => Promise<Output<K>>;
export type Injected = {
  hooks: {
    catalog: HostObservable<Catalog>;
    edits: HostObservable<EditorSnapshot>;
  };
  editAsset(target: EditTarget, patch: AssetPatch, immediate?: boolean): void;
  flushEdits(key?: string): Promise<void>;
  request: Request;
  refresh(): Promise<void>;
  onBack(): void;
  onToggle(): void;
  openLibraryPanel(): void;
  pickDirectory(): Promise<string | undefined>;
};
export type SharedProps = PropsLocale<"asset-library"> &
  PropsStore<ReturnType<typeof createViewStore>> &
  InjectFace<Injected>;
export type PageProps = SharedProps;
/** Navigation supplied by the workbench settings page. */
export type LibrarySettingsNavigation = { openModelSettings(): void };

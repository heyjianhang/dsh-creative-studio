import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRuntime,
  PropsRenderSlots,
} from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionReference } from "@deepseek-ai/dsh-api-session-controller/client";
import type { Input, Output, Method, Project } from "../shared/contracts.ts";
import type { Editor } from "./editor.ts";
export type { Request } from "../shared/contracts.ts";
import type { Request } from "../shared/contracts.ts";
export type State = {
  page: "projects" | "templates";
  projects: Project[];
  current?: Project;
  status: "saved" | "saving" | "error";
  error?: string;
  notice?: string;
  capabilities?: Output<"capabilities">;
  canUndo: boolean;
  canRedo: boolean;
};
export type Injected = {
  hooks: { studio: HostObservable<State> };
  request: Request;
  editor: Editor;
  refresh(): Promise<void>;
  navigate(page: State["page"]): Promise<void>;
  openProject(id: string): Promise<void>;
  createProject(name: string): Promise<void>;
  notify(text: string): void;
  retainAgent(projectId: string): Promise<SessionReference>;
};
export type Shared = PropsLocale<"creative-studio"> & InjectFace<Injected>;
export type PageProps = PropsRuntime<"main"> & Shared;
export type CanvasProps = PropsRuntime<"shell.overlay"> &
  PropsRenderSlots<"creative.agent"> &
  Shared;

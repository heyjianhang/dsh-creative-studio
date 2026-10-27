import { useEffect, useRef, useState } from "react";
import {
  createEditor,
  TextNode,
  $createTextNode,
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $isElementNode,
  $isLineBreakNode,
  $getNodeByKey,
  COMMAND_PRIORITY_HIGH,
  KEY_DOWN_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  HISTORY_PUSH_TAG,
  type EditorConfig,
  type NodeKey,
  type SerializedTextNode,
  type LexicalNode,
} from "lexical";
import { registerPlainText } from "@lexical/plain-text";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import type { PromptPart, CreativeNode } from "../shared/contracts.ts";
import type { Request } from "./props.ts";
import { MediaView } from "./media.tsx";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";

type SerializedReference = SerializedTextNode & {
  nodeId: string;
  label: string;
};
class ReferenceNode extends TextNode {
  __nodeId: string;
  __label: string;
  static getType() {
    return "canvas-reference";
  }
  static clone(n: ReferenceNode) {
    return new ReferenceNode(n.__nodeId, n.__label, n.__key);
  }
  constructor(id: string, label: string, key?: NodeKey) {
    super(`@${label}`, key);
    this.__nodeId = id;
    this.__label = label;
  }
  static importJSON(n: SerializedReference) {
    return new ReferenceNode(n.nodeId, n.label).setMode("token");
  }
  exportJSON(): SerializedReference {
    return {
      ...super.exportJSON(),
      type: "canvas-reference",
      nodeId: this.__nodeId,
      label: this.__label,
    };
  }
  createDOM(config: EditorConfig) {
    const dom = super.createDOM(config);
    dom.className = css.mentionToken;
    dom.dataset.referenceId = this.__nodeId;
    dom.dataset.referenceKey = this.getKey();
    return dom;
  }
  isTextEntity() {
    return true;
  }
  canInsertTextBefore() {
    return false;
  }
  canInsertTextAfter() {
    return false;
  }
}

function readParts(): PromptPart[] {
  const parts: PromptPart[] = [];
  const text = (value: string) => {
    if (!value) return;
    const last = parts.at(-1);
    if (last?.type === "text") last.text += value;
    else parts.push({ type: "text", text: value });
  };
  const visit = (n: LexicalNode) => {
    if (n instanceof ReferenceNode)
      parts.push({ type: "reference", nodeId: n.__nodeId, label: n.__label });
    else if ($isLineBreakNode(n)) text("\n");
    else if ($isTextNode(n)) text(n.getTextContent());
    else if ($isElementNode(n)) n.getChildren().forEach(visit);
  };
  $getRoot()
    .getChildren()
    .forEach((n, i) => {
      if (i) text("\n");
      visit(n);
    });
  return parts;
}

type Props = {
  request: Request;
  projectId: string;
  thumbnails: Record<string, string>;
  value: PromptPart[];
  candidates: CreativeNode[];
  placeholder: string;
  emptyLabel: string;
  limitLabel: string;
  focusAfterPicking: boolean;
  onReferenceHover(id: string | undefined, anchor?: HTMLElement): void;
  onChange(parts: PromptPart[]): void;
  onSubmit(): void;
  onError(message: string): void;
};
type Query = { key: string; start: number; end: number; value: string };
export function PromptEditor(props: Props) {
  const root = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const [query, setQuery] = useState<Query | null>(null);
  const [active, setActive] = useState(0);
  const [empty, setEmpty] = useState(!props.value.length);
  const queryRef = useRef(query);
  queryRef.current = query;
  const choices = props.candidates
    .filter(
      (n) =>
        !query?.value ||
        (n.data.label + n.data.text)
          .toLocaleLowerCase()
          .includes(query.value.toLocaleLowerCase()),
    )
    .slice(0, 12);
  const choicesRef = useRef(choices);
  choicesRef.current = choices;
  const activeRef = useRef(active);
  activeRef.current = active;
  const menu = useRef<HTMLDivElement>(null);
  const serialized = useRef("");
  const paintReferences = () => {
    root.current
      ?.querySelectorAll<HTMLElement>("[data-reference-id]")
      .forEach((dom) => {
        const src = current.current.thumbnails[dom.dataset.referenceId!];
        dom.dataset.hasThumbnail = String(!!src);
        if (src)
          dom.style.setProperty(
            "--reference-thumbnail",
            `url(${JSON.stringify(src)})`,
          );
        else dom.style.removeProperty("--reference-thumbnail");
      });
  };
  const [editor] = useState(() =>
    createEditor({
      namespace: "creative-prompt",
      nodes: [ReferenceNode],
      onError: (e) => current.current.onError(e.message),
    }),
  );
  const choose = (n: CreativeNode) => {
    const q = queryRef.current;
    if (!q) return;
    editor.update(() => {
      const anchor = $getNodeByKey(q.key);
      if (!$isTextNode(anchor)) return;
      const selection = anchor.select(q.start, q.end);
      selection.insertNodes([
        new ReferenceNode(n.id, n.data.label || n.data.kind).setMode("token"),
        $createTextNode(" "),
      ]);
    });
    setQuery(null);
    queryRef.current = null;
    editor.focus();
  };
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  useEffect(() => {
    editor.setRootElement(root.current);
    const dispose = [
      registerPlainText(editor),
      registerHistory(editor, createEmptyHistoryState(), 400),
      editor.registerUpdateListener(paintReferences),
      editor.registerUpdateListener(({ editorState, prevEditorState, tags }) =>
        editorState.read(() => {
          const parts = readParts();
          if (
            parts.length > 500 ||
            parts.reduce(
              (sum, p) =>
                sum + (p.type === "text" ? p.text.length : p.label.length),
              0,
            ) > 30000
          ) {
            editor.setEditorState(prevEditorState, { tag: "limit" });
            current.current.onError(current.current.limitLabel);
            return;
          }
          const json = JSON.stringify(parts);
          setEmpty(!parts.length);
          if (json !== serialized.current) {
            serialized.current = json;
            if (!tags.has("external")) current.current.onChange(parts);
          }
          if (editor.isComposing()) return;
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            queryRef.current = null;
            setQuery(null);
            return;
          }
          const n = selection.anchor.getNode();
          if (!$isTextNode(n) || n instanceof ReferenceNode) {
            queryRef.current = null;
            setQuery(null);
            return;
          }
          const end = selection.anchor.offset;
          const match = n
            .getTextContent()
            .slice(0, end)
            .match(/@([^@\n]{0,60})$/);
          if (!match) {
            queryRef.current = null;
            setQuery(null);
            return;
          }
          const q = {
            key: n.getKey(),
            start: end - match[1].length - 1,
            end,
            value: match[1],
          };
          if (queryRef.current?.value !== q.value) setActive(0);
          queryRef.current = q;
          setQuery(q);
        }),
      ),
      editor.registerCommand(
        KEY_DOWN_COMMAND,
        (event) => {
          if (event.isComposing || editor.isComposing()) return false;
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            current.current.onSubmit();
            return true;
          }
          if (!queryRef.current) return false;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setQuery(null);
            queryRef.current = null;
            return true;
          }
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const length = choicesRef.current.length;
            setActive((i) =>
              length
                ? (i + (event.key === "ArrowDown" ? 1 : -1) + length) % length
                : 0,
            );
            return true;
          }
          if (event.key === "Enter" && choicesRef.current[activeRef.current]) {
            event.preventDefault();
            chooseRef.current(choicesRef.current[activeRef.current]);
            return true;
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];
    return () => {
      dispose.forEach((f) => f());
      editor.setRootElement(null);
    };
  }, [editor]);
  useEffect(paintReferences, [props.thumbnails]);
  useEffect(() => {
    const json = JSON.stringify(props.value);
    if (json === serialized.current) return;
    serialized.current = json;
    editor.update(
      () => {
        const r = $getRoot();
        r.clear();
        let paragraph = $createParagraphNode();
        r.append(paragraph);
        for (const part of props.value) {
          if (part.type === "reference")
            paragraph.append(
              new ReferenceNode(part.nodeId, part.label).setMode("token"),
            );
          else
            part.text.split("\n").forEach((line, i) => {
              if (i) {
                paragraph = $createParagraphNode();
                r.append(paragraph);
              }
              if (line) paragraph.append($createTextNode(line));
            });
        }
      },
      { tag: ["external", SKIP_DOM_SELECTION_TAG] },
    );
  }, [props.value, editor]);
  const wasPicking = useRef(false);
  useEffect(() => {
    if (wasPicking.current && !props.focusAfterPicking) editor.focus();
    wasPicking.current = props.focusAfterPicking;
  }, [props.focusAfterPicking, editor]);
  useEffect(() => {
    menu.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div className={css.promptEditorWrap}>
      <div
        ref={root}
        contentEditable
        suppressContentEditableWarning
        className={css.promptEditor}
        role="textbox"
        aria-multiline="true"
        aria-label={props.placeholder}
        aria-expanded={!!query}
        aria-controls={query ? "creative-mentions" : undefined}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const token = (e.target as Element).closest<HTMLElement>(
            "[data-reference-key]",
          );
          if (!token || e.clientX - token.getBoundingClientRect().left > 24)
            return;
          e.preventDefault();
          e.stopPropagation();
          editor.update(
            () => {
              const reference = $getNodeByKey(token.dataset.referenceKey!);
              if (!(reference instanceof ReferenceNode)) return;
              reference.selectPrevious();
              reference.remove();
            },
            { tag: HISTORY_PUSH_TAG },
          );
          props.onReferenceHover(undefined);
          editor.focus();
        }}
        onPointerMove={(e) => {
          const token = (e.target as Element).closest<HTMLElement>(
            "[data-reference-id]",
          );
          props.onReferenceHover(
            token?.dataset.referenceId,
            token ?? undefined,
          );
        }}
        onPointerLeave={() => props.onReferenceHover(undefined)}
        onInput={() => props.onReferenceHover(undefined)}
        onScroll={() => props.onReferenceHover(undefined)}
        onBlur={(e) => {
          props.onReferenceHover(undefined);
          if (
            !e.currentTarget.parentElement?.contains(e.relatedTarget as Node)
          ) {
            queryRef.current = null;
            setQuery(null);
          }
        }}
      />
      {empty && (
        <div className={css.promptPlaceholder}>{props.placeholder}</div>
      )}
      {query && (
        <div
          ref={menu}
          id="creative-mentions"
          className={css.mentionMenu}
          role="listbox"
          aria-label="@"
        >
          {choices.map((n, i) => (
            <button
              key={n.id}
              type="button"
              role="option"
              aria-selected={i === active}
              data-active={i === active}
              title={n.data.label}
              onPointerMove={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(n)}
            >
              <span className={css.mentionThumbnail} aria-hidden="true">
                {n.data.kind === "image" ? (
                  props.thumbnails[n.id] ? (
                    <img
                      src={props.thumbnails[n.id]}
                      alt=""
                      draggable={false}
                    />
                  ) : (
                    <MediaView
                      request={props.request}
                      projectId={props.projectId}
                      data={n.data}
                      preview
                    />
                  )
                ) : (
                  <Icon name="text" size={18} />
                )}
              </span>
              <span className={css.mentionName}>{n.data.label}</span>
            </button>
          ))}
          {!choices.length && <p>{props.emptyLabel}</p>}
        </div>
      )}
    </div>
  );
}

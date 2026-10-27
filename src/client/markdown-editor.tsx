import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, Tooltip, useModalLayer, writeClipboard } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  createEditor, $getRoot, $getSelection, $isRangeSelection, $createParagraphNode,
  FORMAT_TEXT_COMMAND, UNDO_COMMAND, REDO_COMMAND, SKIP_DOM_SELECTION_TAG,
} from "lexical";
import { registerRichText, $createHeadingNode, $isHeadingNode } from "@lexical/rich-text";
import { registerList, $isListNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, REMOVE_LIST_COMMAND } from "@lexical/list";
import { $setBlocksType } from "@lexical/selection";
import { registerHistory, createEmptyHistoryState } from "@lexical/history";
import { $convertFromMarkdownString, $convertToMarkdownString, registerMarkdownShortcuts } from "@lexical/markdown";
import { DividerNode, markdownNodes, markdownTransformers } from "./markdown-document.ts";
import type { CanvasProps } from "./props.ts";
import { Icon } from "./icons.tsx";
import css from "./studio.module.css";

type Props = {
  p: CanvasProps;
  label: string;
  value: string;
  onChange(value: string, history: boolean): void;
  onClose(): void;
};

export function MarkdownEditor(props: Props) {
  const { p } = props;
  const dialog = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const sourceInput = useRef<HTMLTextAreaElement>(null);
  const current = useRef(props);
  current.current = props;
  const saved = p.useStudio((s) => s);
  const [source, setSource] = useState(false);
  const [empty, setEmpty] = useState(!props.value);
  const [format, setFormat] = useState({ block: "paragraph", bold: false, italic: false });
  const lastValue = useRef(props.value);
  const firstChange = useRef(true);
  const emit = (value: string) => {
    if (lastValue.current === value) return;
    lastValue.current = value;
    current.current.onChange(value, firstChange.current);
    firstChange.current = false;
  };
  const emitRef = useRef(emit);
  emitRef.current = emit;
  const [editor] = useState(() => createEditor({
    namespace: "creative-markdown-body",
    nodes: markdownNodes,
    theme: { text: { bold: css.mdBold, italic: css.mdItalic, code: css.mdInlineCode, strikethrough: css.mdStrike } },
    onError: (error) => current.current.p.notify(error.message),
  }));
  useModalLayer(dialog, true, props.onClose);

  useEffect(() => {
    editor.setRootElement(root.current);
    const dispose = [
      registerRichText(editor),
      registerList(editor),
      registerHistory(editor, createEmptyHistoryState(), 400),
      registerMarkdownShortcuts(editor, markdownTransformers),
      editor.registerUpdateListener(({ editorState, prevEditorState, dirtyElements, dirtyLeaves, tags }) => {
        editorState.read(() => {
          setEmpty(!$getRoot().getTextContent());
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            let node = selection.anchor.getNode();
            let block = "paragraph";
            while (node.getParent()) {
              if ($isHeadingNode(node)) block = node.getTag();
              if ($isListNode(node)) { block = node.getListType(); break; }
              node = node.getParent()!;
            }
            const next = { block, bold: selection.hasFormat("bold"), italic: selection.hasFormat("italic") };
            setFormat((previous) => previous.block === next.block && previous.bold === next.bold && previous.italic === next.italic ? previous : next);
          }
          if (tags.has("body-import") || tags.has("body-limit") || (!dirtyElements.size && !dirtyLeaves.size)) return;
          const value = $convertToMarkdownString(markdownTransformers, undefined, true);
          if (value.length > 30000) {
            editor.setEditorState(prevEditorState, { tag: "body-limit" });
            current.current.p.notify(current.current.p.t("bodyLimit"));
            return;
          }
          emitRef.current(value);
        });
      }),
    ];
    editor.update(() => $convertFromMarkdownString(current.current.value, markdownTransformers, undefined, true), { tag: "body-import", discrete: true });
    editor.focus();
    return () => { dispose.forEach((fn) => fn()); editor.setRootElement(null); };
  }, [editor]);

  useEffect(() => {
    if (props.value === lastValue.current) return;
    lastValue.current = props.value;
    editor.update(() => $convertFromMarkdownString(props.value, markdownTransformers, undefined, true), { tag: ["body-import", SKIP_DOM_SELECTION_TAG] });
  }, [props.value, editor]);

  function block(tag: "paragraph" | "h1" | "h2" | "h3") {
    if (format.block === "number" || format.block === "bullet") editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) $setBlocksType(selection, () => tag === "paragraph" ? $createParagraphNode() : $createHeadingNode(tag));
    });
    editor.focus();
  }
  function toggleSource() {
    if (source) {
      editor.update(() => $convertFromMarkdownString(current.current.value, markdownTransformers, undefined, true), { tag: "body-import", discrete: true });
      setSource(false);
      requestAnimationFrame(() => editor.focus());
    } else {
      setSource(true);
      requestAnimationFrame(() => sourceInput.current?.focus());
    }
  }
  const tool = (label: string, content: ReactNode, run: () => void, active?: boolean) => (
    <Tooltip label={label} side="top" portal>
      <Button aria-label={label} aria-pressed={active} data-active={active} className={css.mdTool}
        onMouseDown={(e) => e.preventDefault()} onClick={run}>{content}</Button>
    </Tooltip>
  );
  return createPortal(
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={p.t("markdownEditor")} tabIndex={-1}
      className={`${css.mediaPreview} ${css.markdownEditor}`} data-shortcut-modal="creative-text-editor">
      <header className={css.previewHeader}>
        <Tooltip label={p.t("back")} side="right"><Button className={css.previewBack} aria-label={p.t("back")} onClick={props.onClose}><Icon name="back" /></Button></Tooltip>
        <span className={css.mdTitle}>{props.label || p.t("text")}</span>
        <div className={css.mdHeaderActions}>
          <span className={css.mdSaveState} role="status">{saved.status === "error" ? p.t("saveFailed") : p.t(saved.status === "saving" ? "saving" : "saved")}</span>
          <Button size="sm" aria-pressed={source} onClick={toggleSource}>{source ? p.t("formattedText") : "Markdown"}</Button>
        </div>
      </header>
      {saved.error && <div className={css.mdError} role="alert">{saved.error}<Button size="sm" onClick={() => void p.editor.flush().catch(() => {})}>{p.t("retry")}</Button></div>}
      <div className={css.mdToolbar} role="toolbar" aria-label={p.t("textFormatting")}>
        <div className={css.mdTools}>
        {tool(p.t("copyText"), <Icon name="copy" size={19} />, () => { void writeClipboard(current.current.value).then((ok) => p.notify(p.t(ok ? "copied" : "copyFailed"))).catch(() => p.notify(p.t("copyFailed"))); })}
        {!source && <>
          <span className={css.mdSeparator} />
          {tool(p.t("heading1"), <Icon name="heading1" />, () => block("h1"), format.block === "h1")}
          {tool(p.t("heading2"), <Icon name="heading2" />, () => block("h2"), format.block === "h2")}
          {tool(p.t("heading3"), <Icon name="heading3" />, () => block("h3"), format.block === "h3")}
          {tool(p.t("paragraph"), <Icon name="paragraph" />, () => block("paragraph"), format.block === "paragraph")}
          <span className={css.mdSeparator} />
          {tool(p.t("bold"), <Icon name="bold" />, () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold"), format.bold)}
          {tool(p.t("italic"), <Icon name="italic" />, () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic"), format.italic)}
          <span className={css.mdSeparator} />
          {tool(p.t("bulletList"), <Icon name="list" size={20} />, () => editor.dispatchCommand(format.block === "bullet" ? REMOVE_LIST_COMMAND : INSERT_UNORDERED_LIST_COMMAND, undefined), format.block === "bullet")}
          {tool(p.t("numberList"), <Icon name="orderedList" />, () => editor.dispatchCommand(format.block === "number" ? REMOVE_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND, undefined), format.block === "number")}
          {tool(p.t("divider"), <Icon name="divider" />, () => editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;
            const paragraph = $createParagraphNode();
            selection.insertNodes([new DividerNode(), paragraph]);
            paragraph.select();
          }))}
          <span className={css.mdSeparator} />
          {tool(p.t("undo"), <Icon name="undo" size={18} />, () => editor.dispatchCommand(UNDO_COMMAND, undefined))}
          {tool(p.t("redo"), <Icon name="redo" size={18} />, () => editor.dispatchCommand(REDO_COMMAND, undefined))}
        </>}
        {source && <span className={css.mdSourceLabel}>Markdown</span>}
        </div>
      </div>
      <div className={css.mdScroll}>
        <main className={css.mdPage}>
          <div hidden={source}>
            <div ref={root} className={css.mdDocument} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true"
              aria-label={p.t("editBody")} data-empty={empty} data-placeholder={p.t("textPlaceholder")} spellCheck />
          </div>
          {source && <textarea ref={sourceInput} className={css.mdSource} value={props.value} maxLength={30000} aria-label="Markdown"
            placeholder={p.t("textPlaceholder")} onChange={(e) => emit(e.target.value)} />}
        </main>
      </div>
    </div>, document.body,
  );
}

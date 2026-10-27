import { DecoratorNode, $createParagraphNode, type NodeKey, type SerializedLexicalNode } from "lexical";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { TRANSFORMERS, type ElementTransformer } from "@lexical/markdown";

export class DividerNode extends DecoratorNode<null> {
  static getType() { return "creative-divider"; }
  static clone(node: DividerNode) { return new DividerNode(node.__key); }
  constructor(key?: NodeKey) { super(key); }
  static importJSON() { return new DividerNode(); }
  exportJSON(): SerializedLexicalNode {
    return { ...super.exportJSON(), type: "creative-divider", version: 1 };
  }
  createDOM() { return document.createElement("hr"); }
  updateDOM() { return false; }
  decorate() { return null; }
  isInline() { return false; }
  getTextContent() { return "---"; }
}

const divider: ElementTransformer = {
  type: "element",
  dependencies: [DividerNode],
  regExp: /^(?:---|\*\*\*|___)\s?$/,
  export: (node) => node instanceof DividerNode ? "---" : null,
  replace: (parent, _children, _match, isImport) => {
    const rule = new DividerNode();
    parent.replace(rule);
    if (!isImport) {
      const paragraph = $createParagraphNode();
      rule.insertAfter(paragraph);
      paragraph.select();
    }
  },
};

export const markdownNodes = [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode, DividerNode];
export const markdownTransformers = [divider, ...TRANSFORMERS];

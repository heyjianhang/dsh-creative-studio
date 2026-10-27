import {
  IconPlusOutlineRegular,
  IconCloseOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconSparkleRegular,
  IconSearchOutlineRegular,
  IconNewChatOutlineRegular,
  IconCopyOutlineRegular,
  IconTrashOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconEllipsisOutlineRegular,
  IconCheckOutlineRegular,
  IconDownloadOutlineRegular,
  IconPlayOutlineRegular,
  IconPauseOutlineRegular,
} from "@deepseek-ai/dsh-client-ui-primitives";
export type IconName =
  | "plus"
  | "close"
  | "folder"
  | "sparkle"
  | "search"
  | "chat"
  | "copy"
  | "trash"
  | "back"
  | "sidebar"
  | "more"
  | "check"
  | "edit"
  | "text"
  | "image"
  | "video"
  | "home"
  | "grid"
  | "list"
  | "heading1"
  | "heading2"
  | "heading3"
  | "paragraph"
  | "bold"
  | "italic"
  | "orderedList"
  | "divider"
  | "down"
  | "upload"
  | "fit"
  | "undo"
  | "redo"
  | "hand"
  | "cursor"
  | "minus"
  | "map"
  | "download"
  | "play"
  | "pause"
  | "help"
  | "arrowUp"
  | "stop"
  | "refresh"
  | "arrow";
const native = {
  plus: IconPlusOutlineRegular,
  close: IconCloseOutlineRegular,
  folder: IconFolderOpenOutlineRegular,
  sparkle: IconSparkleRegular,
  search: IconSearchOutlineRegular,
  chat: IconNewChatOutlineRegular,
  copy: IconCopyOutlineRegular,
  trash: IconTrashOutlineRegular,
  back: IconChevronLeftOutlineRegular,
  sidebar: IconPanelLeftOutlineRegular,
  more: IconEllipsisOutlineRegular,
  check: IconCheckOutlineRegular,
  download: IconDownloadOutlineRegular,
  play: IconPlayOutlineRegular,
  pause: IconPauseOutlineRegular,
};
const paths = {
  edit: "m15 4 5 5M4 20l5-1L20 8a2.1 2.1 0 0 0-4-4L5 15z",
  text: "M5 5h14M12 5v14M8 19h8",
  image: "M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4 M15 8h.01",
  video: "M4 5h16v14H4z M10 9l5 3-5 3z",
  home: "M3 11l9-8 9 8M6 9v12h12V9M10 21v-7h4v7",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  heading1: "M4 5v14M12 5v14M4 12h8m5 1 2-2v8m-2 0h4",
  heading2: "M4 5v14M12 5v14M4 12h8m4 1a2.5 2.5 0 0 1 5 0c0 2-5 3-5 6h5",
  heading3:
    "M4 5v14M12 5v14M4 12h8m4-1h3a2 2 0 0 1 0 4h-2m2 0a2 2 0 0 1 0 4h-3",
  paragraph: "M4 6h16M4 10h16M4 14h16M4 18h10",
  bold: "M6 4h7a4 4 0 0 1 0 8H6V4m0 8h8a4 4 0 0 1 0 8H6v-8",
  italic: "M10 4h9M5 20h9M15 4 9 20",
  orderedList:
    "M10 6h10M10 12h10M10 18h10M3 4h1v5M3 9h3m-3 5a1.5 1.5 0 0 1 3 0c0 1.5-3 2-3 4h3",
  divider: "M4 12h16M7 5h10M7 19h10",
  down: "m6 9 6 6 6-6",
  grid: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
  upload: "M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6",
  fit: "M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6",
  undo: "M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12",
  redo: "m15 5 5 5-5 5M20 10h-10a6 6 0 0 0 0 12",
  hand: "M8 11V5a1.5 1.5 0 0 1 3 0v6-8a1.5 1.5 0 0 1 3 0v8-6a1.5 1.5 0 0 1 3 0v7-3a1.5 1.5 0 0 1 3 0v6c0 5-3 7-7 7-3 0-5-2-7-5l-3-4a1.5 1.5 0 0 1 2-2l3 3",
  cursor: "M5 3v17l5-5 4 7 3-2-4-7h7z",
  minus: "M5 12h14",
  map: "M14 18H3V4h18v7M13 14h8v7h-8z",
  help: "M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 4h.01",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  arrowUp: "M12 20V4m-6 6 6-6 6 6",
  stop: "M7 7h10v10H7z",
  refresh:
    "M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.8-1L20 9M4 15l2.1 3A7 7 0 0 0 17.9 17",
};
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  if (name in native) {
    const C = native[name as keyof typeof native];
    return <C size={size} />;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={paths[name as keyof typeof paths]} />
    </svg>
  );
}

/** The core components plugins get (as `ctx.components`, and re-exported by plugin-api/web.ts). */
export { Modal, Row } from './Modal.tsx';
export { FilesBrowser, NewFileBody, editStats, netItem, type FileNode, type GroupItem } from './FilesBrowser.tsx';
export { Diff, DiffTable, lineKey, parsePatch, type DiffLine } from './Diff.tsx';
export { Menu, type MenuItem } from './Menu.tsx';
export { ConfirmPopover } from './ConfirmPopover.tsx';
export { AsOf } from './AsOf.tsx';
export { Panel } from './Panel.tsx';
export { StatusBadge } from './StatusBadge.tsx';
export { UnreadDot } from './UnreadDot.tsx';
export { CollapsibleBlock } from './CollapsibleBlock.tsx';
export { MoveArrows, useDragReorder, useIsPhone } from './Reorder.tsx';
export { ConversationSearch, findRanges, searchSupported } from './ConversationSearch.tsx';
export { Linkify } from './Linkify.tsx';
export { SourceBlock, Row as StatusRow, RefreshButton } from './StatusRows.tsx';

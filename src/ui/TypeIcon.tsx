import { BookmarkCheck, CheckSquare, Folder, Heading, Minus, Type } from "lucide-react";
import type { ItemType } from "../model/types";

const ICONS = { task: CheckSquare, text: Type, heading: Heading, folder: Folder, template: BookmarkCheck, separator: Minus } as const;

export function TypeIcon({ type, size = 14 }: { type: ItemType; size?: number }) {
  const C = ICONS[type];
  return <C size={size} />;
}

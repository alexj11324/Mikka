import type { ReactNode } from "react";
import type { TableColumn, TableLabels } from "./types";

export const DEFAULT_TABLE_LABELS: TableLabels = {
  selectAll: "Select all rows",
  selectRow: (row) => `Select row ${row}`,
  columnOptions: (column) => `${column} column options`,
  rowOptions: (row) => `Row ${row} options`,
  reorderColumn: (column) => `Reorder ${column} column`,
  renameColumn: (column) => `Rename ${column} column`,
  resizeColumn: (column) => `Resize ${column} column`,
  editCell: (column, row) => `${column} for row ${row}`,
  emptyCell: "Empty",
  insertBefore: "Insert before",
  insertAfter: "Insert after",
  deleteColumn: "Delete column",
  deleteRow: "Delete row",
};

export const CHECKBOX_PX = 48;
export const CHECKBOX_WIDTH = `${CHECKBOX_PX}px`;

/** Highlights the top edge of the active column's header cell. */
export const COLUMN_ACTIVE_SHADOW = "inset 0 1px 0 var(--color-primary)";

export function alignFlex(align: TableColumn<unknown>["align"]) {
  if (align === "right") return "justify-end";
  if (align === "center") return "justify-center";
  return "justify-start";
}

export function alignText(align: TableColumn<unknown>["align"]) {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

export function readCell<T>(row: T, column: TableColumn<T>): ReactNode {
  if (column.cell) return column.cell(row);
  return (row as Record<string, ReactNode>)[column.key];
}

export function readSortValue<T>(
  row: T,
  column: TableColumn<T>,
): string | number {
  if (column.sortValue) return column.sortValue(row);
  return (row as Record<string, string | number>)[column.key];
}

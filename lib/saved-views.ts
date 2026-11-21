import { z } from "zod";

/** The lists a person can save views of. A new list adds its scope here and in drizzle's CHECK. */
export const savedViewScopes = ["pulls", "threads", "tasks"] as const;
export type SavedViewScope = (typeof savedViewScopes)[number];
/** Per person, per workspace, per list. */
export const MAX_SAVED_VIEWS = 50;

export const savedViewName = z.string().trim().min(1).max(80);
/** A list's filters as stored: a small object whose shape the list itself checks on read. */
export const savedViewFilters = z
  .record(z.string().max(64), z.unknown())
  .refine(
    (value) => JSON.stringify(value).length <= 4096,
    "savedViewTooLarge",
  );

export type SavedView<F = Record<string, unknown>> = {
  id: string;
  scope: SavedViewScope;
  name: string;
  filters: F;
  createdAt: string;
};

export const saveViewInput = z.strictObject({
  workspaceId: z.uuid(),
  scope: z.enum(savedViewScopes),
  name: savedViewName,
  filters: savedViewFilters,
});
export type SaveViewInput = z.input<typeof saveViewInput>;

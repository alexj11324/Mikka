"use client";

import { useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import type { RelationKind, SearchResultItem } from "@/lib/issue-search";
import { RELATION_SEARCH_DEBOUNCE_MS, relationCandidates, relationSearchParams, relationSearchQuery } from "@/lib/issue-relation-search";
import { useOnOpen } from "./use-on-open";

/**
 * Relation picker search against GET /api/issues/search. Typing is debounced; a newer query or
 * closing the picker aborts the request in flight. Each opening starts empty (loading), so the
 * picker never shows rows from before the last relation change. While a newer query loads, the
 * previous rows stay so the list does not flash back to loading.
 */
export function useRelationSearch({ open, issueId, kind, query }: { open: boolean; issueId: string; kind: RelationKind; query: string }) {
  const search = relationSearchQuery(query);
  const [q, setQ] = useState(search.q);
  const [reloads, setReloads] = useState(0);
  const [state, setState] = useState<{ items?: SearchResultItem[]; failed?: boolean }>({});
  useOnOpen(open, () => { setState({}); setQ(search.q); });
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.q), RELATION_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search.q]);
  const params = open ? relationSearchParams({ issueId, kind, q }).toString() : null;
  useEffect(() => {
    if (!params) return;
    const controller = new AbortController();
    fetch(withBasePath(`/api/issues/search?${params}`), { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`issue search ${response.status}`);
        return (await response.json() as { items: SearchResultItem[] }).items;
      })
      .then(items => { if (!controller.signal.aborted) setState({ items }); }, () => { if (!controller.signal.aborted) setState(current => ({ ...current, failed: true })); });
    return () => controller.abort();
  }, [params, reloads]);
  return {
    items: state.items,
    rows: state.items ? relationCandidates(state.items, { kind, identifier: search.identifier }) : [],
    failed: Boolean(state.failed),
    reload: () => { setState(current => ({ items: current.items })); setReloads(value => value + 1); },
  };
}

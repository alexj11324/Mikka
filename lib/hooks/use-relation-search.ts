"use client";

import { useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import type { RelationKind, SearchResultItem } from "@/lib/issue-search";
import { RELATION_SEARCH_DEBOUNCE_MS, collectRelationPages, relationCandidates, relationSearchParams, relationSearchQuery } from "@/lib/issue-relation-search";
import { useOnOpen } from "./use-on-open";

/**
 * Relation picker search against GET /api/issues/search. Typing is debounced; a newer query or
 * closing the picker aborts the request in flight. Each opening starts empty (loading), so the
 * picker never shows rows from before the last relation change. While a newer query loads, the
 * previous rows are hidden until the new search completes.
 */
export function useRelationSearch({ open, issueId, kind, query }: { open: boolean; issueId: string; kind: RelationKind; query: string }) {
  const search = relationSearchQuery(query);
  const searchKey = JSON.stringify(search);
  const [key, setKey] = useState(searchKey);
  const [reloads, setReloads] = useState(0);
  const [state, setState] = useState<{ key?: string; items?: SearchResultItem[]; failed?: boolean }>({});
  useOnOpen(open, () => { setState({}); setKey(searchKey); });
  useEffect(() => {
    const timer = setTimeout(() => setKey(searchKey), RELATION_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchKey]);
  const debouncedSearch = JSON.parse(key) as { q: string; identifier: string | null };
  const params = open && key === searchKey ? relationSearchParams({ issueId, kind, q: debouncedSearch.q }).toString() : null;
  useEffect(() => {
    if (!params) return;
    const controller = new AbortController();
    setState({});
    collectRelationPages(async cursor => {
      const pageParams = new URLSearchParams(params);
      if (cursor) pageParams.set("cursor", cursor);
      const response = await fetch(withBasePath(`/api/issues/search?${pageParams}`), { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`issue search ${response.status}`);
      return await response.json() as { items: SearchResultItem[]; nextCursor: string | null };
    }, { kind, identifier: debouncedSearch.identifier })
      .then(items => { if (!controller.signal.aborted) setState({ key, items }); }, () => { if (!controller.signal.aborted) setState({ key, failed: true }); });
    return () => controller.abort();
  }, [params, reloads, kind, debouncedSearch.identifier, key]);
  return {
    items: params && state.key === key ? state.items : undefined,
    rows: params && state.key === key && state.items ? relationCandidates(state.items, { kind, identifier: search.identifier }).slice(0, 50) : [],
    failed: Boolean(params && state.key === key && state.failed),
    reload: () => { setState({}); setReloads(value => value + 1); },
  };
}

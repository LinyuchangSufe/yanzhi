"use client";
import { useEffect, useState } from "react";
import { createLibrarySearch, emptyLibrarySearch, visibleLibrarySearch } from "../../lib/library-search";
import type { KBState } from "../../lib/types";
import { readResponse } from "../WorkspaceShared";

export function useLibrarySearch(query: string, library: KBState | null) {
  const [snapshot, setSnapshot] = useState(emptyLibrarySearch);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const search = createLibrarySearch({
      onChange: setSnapshot,
      load: async (text, signal) => {
        const data = await readResponse(await fetch(`/api/kb?q=${encodeURIComponent(text)}`, {
          cache: "no-store", signal,
        }));
        return data.searchResults || [];
      },
    });
    search.search(query);
    return search.cancel;
  }, [query, library, attempt]);
  const current = visibleLibrarySearch(snapshot, query);
  return { results: current.results, searching: current.status === "pending", searchError: current.error,
    retrySearch: () => setAttempt((value) => value + 1) };
}

import type { SearchResult } from "./types";

export type LibrarySearchSnapshot = {
  query: string;
  status: "idle" | "pending" | "ready" | "error";
  results: SearchResult[];
  error: string;
};
export const emptyLibrarySearch: LibrarySearchSnapshot = {
  query: "", status: "idle", results: [], error: "",
};

/** Bind every result to its query, including debounce and failed requests. */
export function visibleLibrarySearch(snapshot: LibrarySearchSnapshot, query: string): LibrarySearchSnapshot {
  const current = query.trim();
  if (!current) return emptyLibrarySearch;
  if (snapshot.query !== current) return { query: current, status: "pending", results: [], error: "" };
  return snapshot;
}

export function createLibrarySearch(options: {
  load: (query: string, signal: AbortSignal) => Promise<SearchResult[]>;
  onChange: (snapshot: LibrarySearchSnapshot) => void;
  delayMs?: number;
}) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  const cancel = () => {
    generation++;
    clearTimeout(timer);
    request?.abort();
  };
  return {
    cancel,
    search(query: string) {
      cancel();
      const current = query.trim();
      if (!current) { options.onChange(emptyLibrarySearch); return; }
      const id = generation;
      options.onChange({ query: current, status: "pending", results: [], error: "" });
      timer = setTimeout(async () => {
        request = new AbortController();
        try {
          const results = await options.load(current, request.signal);
          if (id === generation) options.onChange({ query: current, status: "ready", results, error: "" });
        } catch (error) {
          if (id === generation) options.onChange({ query: current, status: "error", results: [],
            error: error instanceof Error ? error.message : "搜索暂时失败，请重试。" });
        }
      }, options.delayMs ?? 250);
    },
  };
}

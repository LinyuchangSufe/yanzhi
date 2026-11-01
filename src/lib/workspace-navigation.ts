import type { Section, Tab, View } from "../components/WorkspaceShared";

export interface WorkspaceLocation {
  view: View;
  section: Section;
  tab: Tab;
}

const sections = new Set<Section>(["all", "unread", "trash", "topics", "ideas", "reference", "discussions", "settings"]);
const tabs = new Set<Tab>(["notes", "annotations", "ai", "chat"]);
const entityKinds = new Set(["paper", "topic", "note", "discussion"]);
const identifier = /^[a-zA-Z0-9-]{1,128}$/;

/** URL state is limited to known views and stable identifiers, never arbitrary paths. */
export function workspaceLocation(search: string): WorkspaceLocation {
  const params = new URLSearchParams(search);
  const section = params.get("section") as Section;
  const tab = params.get("tab") as Tab;
  const kind = params.get("view");
  const id = params.get("id");
  return {
    view: kind && entityKinds.has(kind) && id && identifier.test(id)
      ? { kind: kind as "paper" | "topic" | "note" | "discussion", id }
      : { kind: "home" },
    section: sections.has(section) ? section : "all",
    tab: tabs.has(tab) ? tab : "notes",
  };
}

export function workspaceHref(location: WorkspaceLocation, pathname = "/"): string {
  const params = new URLSearchParams();
  if (location.section !== "all") params.set("section", location.section);
  if (location.view.kind !== "home") {
    params.set("view", location.view.kind);
    params.set("id", location.view.id);
    if (location.view.kind === "paper" && location.tab !== "notes") params.set("tab", location.tab);
  }
  return `${pathname}${params.size ? `?${params}` : ""}`;
}

export function isWorkspaceLink(hash: string): boolean {
  return /^#(?:paper|annotation|note|topic|ai|discussion|research-item)\/[a-zA-Z0-9-]{1,128}$/.test(hash);
}

/** Browser history is untrusted and may include entries from other application versions. */
export function storedWorkspaceLocation(value: unknown): WorkspaceLocation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const view = record.view;
  if (!view || typeof view !== "object") return null;
  const target = view as Record<string, unknown>;
  if (!sections.has(record.section as Section) || !tabs.has(record.tab as Tab)) return null;
  if (target.kind !== "home" &&
      !(entityKinds.has(String(target.kind)) && typeof target.id === "string" && identifier.test(target.id))) return null;
  return {
    view: target.kind === "home" ? { kind: "home" } : { kind: target.kind as "paper" | "topic" | "note" | "discussion", id: target.id as string },
    section: record.section as Section,
    tab: record.tab as Tab,
  };
}

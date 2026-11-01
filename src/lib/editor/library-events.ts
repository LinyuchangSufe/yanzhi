const channelName = "research-library-windows-v1";
const storageKey = "research-library-window-event";
export type LibraryEvent = { id: string; type: "changed" } | { id: string; type: "navigate"; href: string };
let channel: BroadcastChannel | null | undefined;
function getChannel() {
  if (channel === undefined) {
    try { channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(channelName); }
    catch { channel = null; }
  }
  return channel;
}
export function validLibraryEvent(value: unknown): value is LibraryEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === "string" && event.id.length <= 80 &&
    (event.type === "changed" || (event.type === "navigate" && typeof event.href === "string" &&
      /^(?:kb:\/\/|#)(paper|annotation|note|topic|ai)\/[a-zA-Z0-9-]+$/.test(event.href)));
}
function publish(event: LibraryEvent) {
  try { getChannel()?.postMessage(event); } catch {}
  try { localStorage.setItem(storageKey, JSON.stringify(event)); } catch {}
}
export function publishLibraryChange() { publish({ id: crypto.randomUUID(), type: "changed" }); }
export function publishLibraryNavigation(href: string) {
  const event = { id: crypto.randomUUID(), type: "navigate" as const, href };
  if (validLibraryEvent(event)) publish(event);
}
export function subscribeLibraryEvents(receive: (event: LibraryEvent) => void) {
  const seen = new Set<string>();
  const accept = (event: unknown) => {
    if (!validLibraryEvent(event) || seen.has(event.id)) return;
    seen.add(event.id);
    if (seen.size > 64) seen.delete(seen.values().next().value!);
    receive(event);
  };
  const message = (event: MessageEvent<unknown>) => accept(event.data);
  const storage = (event: StorageEvent) => {
    if (event.key !== storageKey || !event.newValue) return;
    try { accept(JSON.parse(event.newValue)); } catch {}
  };
  const current = getChannel();
  current?.addEventListener("message", message);
  window.addEventListener("storage", storage);
  return () => { current?.removeEventListener("message", message); window.removeEventListener("storage", storage); };
}

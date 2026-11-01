/** Only the dedicated local raster-image endpoint may be embedded in note previews. */
export function localNoteImageId(source: unknown): string | null {
  if (typeof source !== "string") return null;
  return (
    /^\/api\/kb\/image\?id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
      .exec(source)?.[1]
      .toLowerCase() ?? null
  );
}

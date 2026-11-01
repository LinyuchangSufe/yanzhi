/** Only article-identifying paths; never scan queries, references or search pages. */
export function doiFromSourceUrl(source: string): string {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    return "";
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return "";
  }
  const doiHost = /^(?:dx\.)?doi\.org$/i.test(url.hostname);
  const match = doiHost
    ? pathname.match(/^\/(10\.\d{4,9}\/\S+)$/i)
    : pathname.match(
        /^\/(?:doi\/(?:(?:full|abs|abstract|pdf|epdf|pdfplus|reader|am-pdf)\/)?|articles?\/)(10\.\d{4,9}\/\S+)$/i,
      );
  const doi = match?.[1] ?? "";
  // A nested DOI or a publisher subpage is not a single article identifier.
  if (!doi || /\/10\.\d{4,9}\//i.test(doi) || /\/(?:references|figures|tables|metrics|supplementary)(?:\/|$)/i.test(doi))
    return "";
  return doi.toLowerCase();
}

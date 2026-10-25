/** Classifies a failed turn's error into the pool action to take, or null when unrelated. */
export function classifyFailure(
  message: string,
  code?: string,
): "window" | "auth" | null {
  const haystack = `${code ?? ""} ${message}`.toLowerCase();
  if (/(^|\D)(401|403)(\D|$)/.test(haystack) || /unauthorized|invalid api key|api key.*(invalid|expired)|signed out|forbidden/.test(haystack)) {
    return "auth";
  }
  if (
    /(^|\D)429(\D|$)/.test(haystack) ||
    /rate.?limit|quota|usage limit|limit reached|exceed(ed|s)?|too many requests|out of (credits|room)|window/.test(haystack)
  ) {
    return "window";
  }
  return null;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  "content-length",
]);

const REQUEST_ONLY_DROP = new Set(["accept-encoding"]);

export function buildUpstreamHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  incoming.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || REQUEST_ONLY_DROP.has(lower)) return;
    headers.append(key, value);
  });
  // Keep the upstream body readable so usage can be parsed from the response.
  headers.set("accept-encoding", "identity");
  return headers;
}

export function buildClientResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  upstream.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    headers.append(key, value);
  });
  return headers;
}

// HTTP client for isomorphic-git built on the global fetch. The client the
// library bundles (isomorphic-git/http/node) hangs under Bun
// (isomorphic-git/isomorphic-git#1966); fetch behaves identically under Bun,
// Node >= 18 and Electron's main process, so this is the one transport for
// every runtime the server modules support (specs/desktop-app.spec.md).

interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Request body as produced by isomorphic-git: an iterable of chunks. */
  body?: AsyncIterableIterator<Uint8Array> | Uint8Array[];
}

interface GitHttpResponse {
  url: string;
  method?: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body?: AsyncIterableIterator<Uint8Array>;
}

async function collect(
  body: AsyncIterableIterator<Uint8Array> | Uint8Array[],
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function* iterate(stream: ReadableStream<Uint8Array>): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export const gitHttp = {
  async request(req: GitHttpRequest): Promise<GitHttpResponse> {
    const res = await fetch(req.url, {
      method: req.method ?? "GET",
      headers: req.headers,
      body: req.body ? await collect(req.body) : undefined,
      redirect: "follow",
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      url: res.url || req.url,
      method: req.method,
      statusCode: res.status,
      statusMessage: res.statusText,
      headers,
      body: res.body ? iterate(res.body) : undefined,
    };
  },
};

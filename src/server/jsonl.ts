// JSON lines framing, shared by the agent providers that speak it over a
// subprocess's stdio (Pi's RPC mode, Codex's app-server). Strict: records
// are split on "\n" only, with one trailing "\r" stripped. Node's readline
// also splits on U+2028/U+2029, which are legal inside JSON strings, so it
// must not be used for this.

/** A JSONL reader: chunks in, whole records out. */
export function jsonlReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) onLine(line);
    }
  };
}

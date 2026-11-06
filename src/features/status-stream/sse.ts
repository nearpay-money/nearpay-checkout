/**
 * Incremental `text/event-stream` parser (WHATWG HTML §9.2.6, the parts NearPay uses: `event`, `data`,
 * `id`, `retry`, comments). Pure: feed decoded text chunks, get complete events back.
 */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
  readonly id: string | null;
}

export class SseParser {
  private buffer = "";
  private eventName = "";
  private data: string[] = [];
  private lastId: string | null = null;
  /** Reconnection delay requested by the server (`retry:`), ms. */
  retryMs: number | null = null;

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) break;
      // A lone trailing "\r" may be the first half of "\r\n": wait for more input.
      if (m[0] === "\r" && m.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.eventName = "";
        return null;
      }
      const ev: SseEvent = { event: this.eventName || "message", data: this.data.join("\n"), id: this.lastId };
      this.eventName = "";
      this.data = [];
      return ev;
    }
    if (line.startsWith(":")) return null;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.lastId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;
    }
    return null;
  }
}

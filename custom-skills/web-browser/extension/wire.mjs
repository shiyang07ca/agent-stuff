// Both directions stay below Native Messaging's 1 MB per-message limit.
export const PROTOCOL = 1;
const PART = 128 * 1024;
const MAX = 64 * 1024 * 1024;
let nextChunk = 0;

export function packets(value) {
  const text = JSON.stringify(value);
  if (text.length > MAX) throw new Error("Browser message exceeds 64 Mi characters");
  if (text.length <= PART) return [value];
  const chunk = String(++nextChunk);
  const total = Math.ceil(text.length / PART);
  return Array.from({ length: total }, (_, index) => ({ chunk, index, total, data: text.slice(index * PART, (index + 1) * PART) }));
}

export function receiver(deliver) {
  let pending = null;
  return (packet) => {
    if (!packet || typeof packet !== "object") throw new Error("Invalid browser message");
    if (!Object.hasOwn(packet, "chunk")) {
      if (pending) throw new Error("Interrupted browser message");
      return deliver(packet);
    }
    if (!Number.isInteger(packet.total) || packet.total < 1 || packet.total > MAX / PART ||
        !Number.isInteger(packet.index) || typeof packet.data !== "string" || packet.data.length > PART) {
      throw new Error("Invalid browser message chunk");
    }
    if (!pending) pending = { id: packet.chunk, total: packet.total, parts: [], started: Date.now() };
    if (packet.chunk !== pending.id || packet.total !== pending.total || packet.index !== pending.parts.length || Date.now() - pending.started > 30000) {
      throw new Error("Invalid or expired browser message sequence");
    }
    pending.parts.push(packet.data);
    if (pending.parts.length === pending.total) {
      const text = pending.parts.join("");
      pending = null;
      deliver(JSON.parse(text));
    }
  };
}

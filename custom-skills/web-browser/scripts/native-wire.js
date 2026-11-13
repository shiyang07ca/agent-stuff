import { endianness } from "node:os";
import { packets, receiver } from "../extension/wire.mjs";

const little = endianness() === "LE";
export function writeMessage(stream, message) {
  for (const packet of packets(message)) {
    const body = Buffer.from(JSON.stringify(packet));
    const header = Buffer.alloc(4);
    if (little) header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
    stream.write(Buffer.concat([header, body]));
  }
}

export function readMessages(stream, deliver, fail) {
  let buffer = Buffer.alloc(0);
  const receive = receiver(deliver);
  stream.on("data", (data) => {
    try {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4) {
        const length = little ? buffer.readUInt32LE() : buffer.readUInt32BE();
        if (length < 2 || length > 1024 * 1024) throw new Error("Invalid native browser frame size");
        if (buffer.length < length + 4) break;
        const packet = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
        buffer = buffer.subarray(length + 4);
        receive(packet);
      }
    } catch (error) { fail(error); }
  });
}

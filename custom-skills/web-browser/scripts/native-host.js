#!/usr/bin/env node
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL } from "../extension/wire.mjs";
import { socketDirectory } from "./extension-connection.js";
import { readMessages, writeMessage } from "./native-wire.js";

const browser = process.argv[2];
if (!["edge", "chrome"].includes(browser)) throw new Error("Native host requires edge or chrome");
const path = join(socketDirectory(), `${browser}-${randomUUID()}.sock`);
const clients = new Map();
let listening = false;
let ending = false;
const server = createServer((socket) => {
  const client = randomUUID();
  clients.set(client, socket);
  readMessages(socket, (request) => {
    try { writeMessage(process.stdout, { client, request }); }
    catch (error) { socket.destroy(error); }
  }, (error) => socket.destroy(error));
  socket.on("error", () => {}); // close removes the client and releases its attachments.
  socket.on("close", () => {
    clients.delete(client);
    if (!ending) writeMessage(process.stdout, { client, disconnect: true });
  });
});
function finish(error) {
  if (ending) return;
  ending = true;
  if (error) console.error(error.message);
  for (const socket of clients.values()) socket.destroy();
  server.close();
  if (listening) { try { unlinkSync(path); } catch (cause) { if (cause.code !== "ENOENT") console.error(cause.message); } }
  process.exit(error ? 1 : 0);
}
server.on("error", finish);
process.stdout.on("error", finish);
process.stdin.on("end", () => finish());
process.stdin.on("error", finish);
process.once("SIGTERM", () => finish());
process.once("SIGINT", () => finish());
const startup = setTimeout(() => finish(new Error("Extension handshake timed out")), 10000);
readMessages(process.stdin, (packet) => {
  if (packet.hello) {
    if (listening || packet.hello.protocol !== PROTOCOL || packet.hello.browser !== browser) return finish(new Error("Extension/host version or browser mismatch; reload the extension"));
    clearTimeout(startup);
    server.listen(path, () => { listening = true; chmodSync(path, 0o600); });
  } else if (typeof packet.client === "string" && packet.message) {
    const socket = clients.get(packet.client);
    if (socket && !socket.destroyed) writeMessage(socket, packet.message);
  } else finish(new Error("Invalid extension response"));
}, finish);

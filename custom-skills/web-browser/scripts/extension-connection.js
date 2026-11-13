import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { lstatSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readMessages, writeMessage } from "./native-wire.js";

export function socketDirectory() {
  // macOS Unix socket paths have a small length limit; don't use a profile path.
  const directory = `/tmp/agent-web-${process.getuid()}`;
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error(`Browser socket directory must belong to this user with mode 0700: ${directory}`);
  }
  return directory;
}

function openSocket(path, timeout) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Browser bridge connection timed out: ${path}`)); }, timeout);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
  });
}

export async function connectExtension(config, timeout = 3000) {
  const directory = socketDirectory();
  const names = readdirSync(directory).filter((name) => name.startsWith(`${config.browser}-`) && name.endsWith(".sock"));
  const sockets = [];
  try {
    for (const name of names) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error(`Invalid browser socket: ${path}`);
      try { sockets.push(await openSocket(path, timeout)); }
      catch (error) { if (!["ECONNREFUSED", "ENOENT"].includes(error.code)) throw error; }
    }
    if (sockets.length !== 1) throw new Error(sockets.length ?
      `Multiple ${config.label} profiles are connected; enable Agent Web Browser in only one profile` :
      `${config.label} extension is not connected; load Agent Web Browser and check its connection status (see setup.md)`);
    return new ExtensionTransport(sockets[0]);
  } catch (error) { for (const socket of sockets) socket.destroy(); throw error; }
}

class ExtensionTransport extends EventEmitter {
  readyState = 1;
  constructor(socket) {
    super();
    this.socket = socket;
    readMessages(socket, (message) => this.emit("message", JSON.stringify(message)), (error) => socket.destroy(error));
    socket.on("error", (error) => this.emit("error", error));
    socket.on("close", () => { this.readyState = 3; this.emit("close"); });
  }
  send(text, callback) {
    try { writeMessage(this.socket, JSON.parse(text)); callback?.(); }
    catch (error) { callback?.(error); }
  }
  terminate() { this.socket.destroy(); }
}

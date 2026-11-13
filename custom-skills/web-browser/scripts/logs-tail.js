#!/usr/bin/env node
import { openSync, closeSync, readSync, fstatSync, watch } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { parseCommand, run } from "./cli.js";

await run(async () => {
  const { values } = parseCommand({ file: { type: "string" }, follow: { type: "boolean" } });
  if (!values.file) throw new Error("--file <path> is required");
  const fd = openSync(values.file, "r");
  let watcher;
  let offset = 0;
  let decoder = new StringDecoder("utf8");
  const readNew = () => {
    if (fstatSync(fd).size < offset) { offset = 0; decoder = new StringDecoder("utf8"); }
    const buffer = Buffer.alloc(65536);
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, offset)) > 0) {
      offset += bytes;
      process.stdout.write(decoder.write(buffer.subarray(0, bytes)));
    }
  };
  let finish;
  try {
    if (!values.follow) { readNew(); return; }
    await new Promise((resolve, reject) => {
      finish = resolve;
      watcher = watch(values.file, () => { try { readNew(); } catch (error) { reject(error); } });
      watcher.on("error", reject);
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      readNew();
      console.error(`Tailing ${values.file}`);
    });
  } finally {
    if (finish) { process.off("SIGINT", finish); process.off("SIGTERM", finish); }
    watcher?.close();
    closeSync(fd);
  }
});

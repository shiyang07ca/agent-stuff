#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parseCommand } from "./cli.js";

const { values } = parseCommand({ file: { type: "string" } });
const filePath = values.file;
if (!filePath) {
  console.error("✗ --file <path> is required");
  process.exit(1);
}

const statusCounts = new Map();
const failures = [];
let totalResponses = 0;
let totalRequests = 0;

try {
  const data = readFileSync(filePath, "utf8");
  const lines = data.split("\n").filter(Boolean);
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "network.request") {
      totalRequests += 1;
    } else if (entry.type === "network.response") {
      totalResponses += 1;
      const status = String(entry.status ?? "unknown");
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    } else if (entry.type === "network.failure") {
      failures.push({
        requestId: entry.requestId,
        errorText: entry.errorText,
      });
    }
  }
} catch (e) {
  console.error("✗ Summary failed:", e.message);
  process.exit(1);
}

console.log(`file: ${filePath}`);
console.log(`requests: ${totalRequests}`);
console.log(`responses: ${totalResponses}`);

const statuses = Array.from(statusCounts.entries()).sort(
  (a, b) => Number(a[0]) - Number(b[0]),
);
for (const [status, count] of statuses) {
  console.log(`status ${status}: ${count}`);
}

if (failures.length > 0) {
  console.log("failures:");
  for (const failure of failures.slice(0, 10)) {
    console.log(`- ${failure.errorText || "unknown"} (${failure.requestId})`);
  }
  if (failures.length > 10) {
    console.log(`- ... ${failures.length - 10} more`);
  }
}

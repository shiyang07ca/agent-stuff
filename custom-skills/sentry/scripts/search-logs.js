#!/usr/bin/env node

import { SENTRY_API_BASE, getAuthToken, fetchJson, formatTimestamp } from "../lib/auth.js";

const LOG_FIELDS = [
  "sentry.item_id",
  "trace",
  "sentry.severity",
  "timestamp",
  "message",
];

/**
 * 解析 Sentry logs explorer URL
 * 示例:
 *   https://earendil.sentry.io/explore/logs/?project=123&statsPeriod=14d
 *   https://sentry.io/organizations/myorg/explore/logs/?project=123
 */
function parseLogsUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const params = url.searchParams;
    const result = {};

    // 从子域名（earendil.sentry.io）或路径（/organizations/myorg/）中提取 org
    const subdomainMatch = url.hostname.match(/^([^.]+)\.sentry\.io$/);
    if (subdomainMatch && subdomainMatch[1] !== "www") {
      result.org = subdomainMatch[1];
    } else {
      const pathMatch = url.pathname.match(/\/organizations\/([^/]+)\//);
      if (pathMatch) {
        result.org = pathMatch[1];
      }
    }

    // 提取 project ID
    if (params.has("project")) {
      result.project = params.get("project");
    }

    // 提取时间范围
    if (params.has("statsPeriod")) {
      result.period = params.get("statsPeriod");
    }

    // 提取查询
    if (params.has("logsQuery")) {
      result.query = params.get("logsQuery");
    }

    return result;
  } catch {
    return null;
  }
}

function parseArgs(args) {
  const options = {
    org: null,
    project: null,
    query: null,
    period: "24h",
    limit: 100,
    json: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--org" || arg === "-o") {
      options.org = args[++i];
    } else if (arg === "--project" || arg === "-p") {
      options.project = args[++i];
    } else if (arg === "--period" || arg === "-t") {
      options.period = args[++i];
    } else if (arg === "--limit" || arg === "-n") {
      options.limit = parseInt(args[++i], 10);
    } else if (!arg.startsWith("-")) {
      // 检查是否为 Sentry URL
      if (arg.includes("sentry.io/") && arg.includes("/logs")) {
        const urlOptions = parseLogsUrl(arg);
        if (urlOptions) {
          if (urlOptions.org) options.org = urlOptions.org;
          if (urlOptions.project) options.project = urlOptions.project;
          if (urlOptions.period) options.period = urlOptions.period;
          if (urlOptions.query) options.query = urlOptions.query;
        }
      } else if (!options.query) {
        options.query = arg;
      }
    }
  }

  return options;
}

function showHelp() {
  console.log(`Usage: search-logs.js [query|url] [options]

Search for logs in Sentry.

Arguments:
  query              Search query (e.g., "level:error", "user.id:123")
  url                Sentry logs explorer URL (extracts org, project, period)

Options:
  --org, -o <org>    Organization slug (required unless URL provided)
  --project, -p <p>  Project slug or ID to filter by
  --period, -t <p>   Time period (default: 24h, e.g., 1h, 7d, 90d)
  --limit, -n <n>    Max results (default: 100, max: 1000)
  --json             Output raw JSON
  -h, --help         Show this help

Search Query Syntax:
  level:error              Filter by log level (trace, debug, info, warn, error, fatal)
  message:*timeout*        Search message text
  trace:abc123             Filter by trace ID
  project:my-project       Filter by project slug

  Combine filters: level:error message:*failed*

Examples:
  search-logs.js --org myorg
  search-logs.js "level:error" --org myorg --project backend
  search-logs.js "message:*timeout*" --org myorg --period 7d
  search-logs.js --org myorg --limit 50 --json

  # Use a Sentry URL directly:
  search-logs.js "https://myorg.sentry.io/explore/logs/?project=123&statsPeriod=7d"
`);
}

function formatLogEntry(entry) {
  const lines = [];

  const ts = entry.timestamp || "N/A";
  const severity = entry["sentry.severity"] || "info";
  const message = entry.message || "(no message)";
  const trace = entry.trace || null;

  // 格式化 timestamp 以便展示
  let displayTs = ts;
  try {
    const date = new Date(ts);
    if (!isNaN(date.getTime())) {
      displayTs = date.toISOString().replace("T", " ").slice(0, 19);
    }
  } catch {}

  // 在输出中对齐 severity
  const severityDisplay = `[${severity.toUpperCase().padEnd(5)}]`;

  lines.push(`${displayTs} ${severityDisplay} ${message}`);

  if (trace) {
    lines.push(`  trace: ${trace}`);
  }

  return lines.join("\n");
}

function formatOutput(data) {
  if (!data.data || data.data.length === 0) {
    return "No logs found matching your query.";
  }

  const lines = [];
  lines.push(`Found ${data.data.length} log entries:\n`);

  for (const entry of data.data) {
    lines.push(formatLogEntry(entry));
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (!options.org) {
    console.error("Error: Missing --org");
    console.error("Run --help for usage");
    process.exit(1);
  }

  const token = getAuthToken();

  // 构建查询参数
  const params = new URLSearchParams();
  params.set("dataset", "logs");
  params.set("statsPeriod", options.period);
  params.set("per_page", Math.min(options.limit, 1000).toString());
  params.set("sort", "-timestamp");

  // 添加字段
  for (const field of LOG_FIELDS) {
    params.append("field", field);
  }

  // 构建搜索查询
  const queryParts = [];
  if (options.project) {
    queryParts.push(`project:${options.project}`);
  }
  if (options.query) {
    queryParts.push(options.query);
  }
  if (queryParts.length > 0) {
    params.set("query", queryParts.join(" "));
  }

  const url = `${SENTRY_API_BASE}/organizations/${encodeURIComponent(options.org)}/events/?${params.toString()}`;

  try {
    const data = await fetchJson(url, token);

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatOutput(data));
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();

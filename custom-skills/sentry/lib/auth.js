import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const SENTRY_API_BASE = "https://sentry.io/api/0";

// project slug -> ID 的解析缓存
const projectIdCache = new Map();

/**
 * 从 ~/.sentryclirc 读取 auth token
 * @returns {string} auth token
 */
export function getAuthToken() {
  const rcPath = join(homedir(), ".sentryclirc");
  if (!existsSync(rcPath)) {
    console.error("Error: ~/.sentryclirc not found");
    console.error("Run 'sentry-cli login' to authenticate");
    process.exit(1);
  }

  const content = readFileSync(rcPath, "utf-8");
  const match = content.match(/token\s*=\s*(.+)/);
  if (!match) {
    console.error("Error: No token found in ~/.sentryclirc");
    process.exit(1);
  }
  return match[1].trim();
}

/**
 * 从 Sentry API endpoint 获取 JSON
 * @param {string} url - 要请求的完整 URL
 * @param {string} token - auth token
 * @returns {Promise<any>} 解析后的 JSON 响应
 */
export async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * 格式化 timestamp 以便展示
 * @param {string|number} ts - timestamp（ISO 字符串或 unix 时间戳）
 * @returns {string} 格式化后的 timestamp
 */
export function formatTimestamp(ts) {
  if (!ts) return "N/A";
  try {
    const date = new Date(ts);
    if (isNaN(date.getTime())) return ts;
    return date.toLocaleString();
  } catch {
    return ts;
  }
}

/**
 * 把 project slug 解析为对应的数字 ID。
 * 如果输入本身已是数字 ID，则原样返回。
 * @param {string} org - organization slug
 * @param {string} project - project slug 或数字 ID
 * @param {string} token - auth token
 * @returns {Promise<string>} 数字 project ID
 */
export async function resolveProjectId(org, project, token) {
  // 已经是数字则原样返回
  if (/^\d+$/.test(project)) {
    return project;
  }

  // 检查缓存
  const cacheKey = `${org}/${project}`;
  if (projectIdCache.has(cacheKey)) {
    return projectIdCache.get(cacheKey);
  }

  // 请求 project 详情以获取 ID
  const url = `${SENTRY_API_BASE}/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/`;
  const data = await fetchJson(url, token);

  if (!data || !data.id) {
    throw new Error(`Project '${project}' not found in organization '${org}'`);
  }

  const id = String(data.id);
  projectIdCache.set(cacheKey, id);
  return id;
}

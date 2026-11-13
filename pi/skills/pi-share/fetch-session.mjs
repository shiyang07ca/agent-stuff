#!/usr/bin/env node
/**
 * 获取并解析 pi-share (shittycodingagent.ai/buildwithpi.ai/buildwithpi.com/pi.dev) 会话导出。
 *
 * 用法:
 *   node fetch-session.mjs <url-or-gist-id> [--header] [--entries] [--system] [--tools] [--human-summary] [--no-cache]
 *
 * 选项:
 *   (无 flag)        输出完整会话数据 JSON
 *   --header         仅输出会话 header
 *   --entries        以 JSON lines 输出 entry（每行一个）
 *   --system         输出 system prompt
 *   --tools          输出 tool 定义
 *   --human-summary  使用 Pi 默认模型总结人类做了什么
 *   --no-cache       绕过缓存，重新获取
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const CACHE_DIR = join(tmpdir(), 'pi-share-cache');

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith('--'));
const flags = new Set(args.filter(a => a.startsWith('--')));

if (!input) {
  console.error('Usage: node fetch-session.mjs <url-or-gist-id> [--header|--entries|--system|--tools]');
  process.exit(1);
}

// 缓存函数
function getCachePath(gistId) {
  return join(CACHE_DIR, `${gistId}.json`);
}

function readCache(gistId) {
  const path = getCachePath(gistId);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'));
  }
  return null;
}

function writeCache(gistId, data) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(getCachePath(gistId), JSON.stringify(data));
}

// 从 URL 中提取 gist ID，或直接使用输入值
function extractGistId(input) {
  const HEX_ID_RE = /^[a-f0-9]{8,40}$/i;
  const normalize = (value = '') => value.trim().replace(/^#/, '');

  // 处理直接的 gist ID 与 #<gist-id>
  const normalizedInput = normalize(input);
  if (HEX_ID_RE.test(normalizedInput)) return normalizedInput;

  // 解析 URL 形式（支持 shittycodingagent.ai、buildwithpi.ai/.com、pi.dev 别名）
  try {
    const url = new URL(input);

    // 处理旧式 query: /session/?<gist-id>
    const bareQuery = normalize(url.search.replace(/^\?/, ''));
    if (HEX_ID_RE.test(bareQuery)) return bareQuery;

    // 处理带键的 query 参数: ?id=<gist-id>、?gist=<gist-id> 等
    for (const value of url.searchParams.values()) {
      const normalizedValue = normalize(value);
      if (HEX_ID_RE.test(normalizedValue)) return normalizedValue;
    }

    // 处理 hash 形式: /session/#<gist-id>
    const hashValue = normalize(url.hash);
    if (HEX_ID_RE.test(hashValue)) return hashValue;

    // 处理基于路径的 URL，如 /session/<gist-id>
    const segments = url.pathname.split('/').filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      if (segments[i] === 'session' && HEX_ID_RE.test(segments[i + 1] || '')) {
        return segments[i + 1];
      }
    }

    // 处理 gist.github.com URL
    if (url.hostname === 'gist.github.com') {
      const gistCandidate = segments[segments.length - 1];
      if (HEX_ID_RE.test(gistCandidate || '')) return gistCandidate;
    }
  } catch {
    // 不是 URL；继续走下方的正则回退
  }

  // 对于包含 gist ID 但格式未知的 URL 使用正则回退
  const fallbackMatch = input.match(/([a-f0-9]{8,40})/i);
  if (fallbackMatch) return fallbackMatch[1];

  throw new Error(`Could not extract a gist ID from input: ${input}`);
}

// 从 gist 获取会话 HTML
async function fetchSessionHtml(gistId) {
  const gistRes = await fetch(`https://api.github.com/gists/${gistId}`);
  if (!gistRes.ok) {
    if (gistRes.status === 404) throw new Error('Session not found (the gist may have been deleted or the ID is invalid)');
    throw new Error(`GitHub API error: ${gistRes.status}`);
  }

  const gist = await gistRes.json();
  const file = gist.files?.['session.html'];
  if (!file) {
    const available = Object.keys(gist.files || {}).join(', ') || 'none';
    throw new Error(`No session.html found in the gist. Available files: ${available}`);
  }

  // 内容被截断时获取原始内容
  if (file.truncated && file.raw_url) {
    const rawRes = await fetch(file.raw_url);
    if (!rawRes.ok) throw new Error('Failed to fetch raw content');
    return rawRes.text();
  }

  return file.content;
}

// 从 HTML 中提取 base64 编码的会话数据
function extractSessionData(html) {
  // 新格式: <script id="session-data" type="application/json">BASE64</script>
  const match = html.match(/<script[^>]*id="session-data"[^>]*>([^<]+)<\/script>/);
  if (match) {
    const base64 = match[1].trim();
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(json);
  }

  throw new Error('No session data found in HTML. This may be an older export format without embedded data.');
}

// 将文本截断到 maxLen，如被截断则追加省略号
function truncate(text, maxLen = 150) {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

// 提取精简后的会话数据，供人类视角摘要使用
function extractForSummary(data) {
  const turns = [];
  let turnNumber = 0;

  for (const entry of data.entries) {
    if (entry.type !== 'message') continue;

    const msg = entry.message;
    if (!msg || !msg.role) continue;

    if (msg.role === 'user') {
      turnNumber++;
      // 提取用户文本
      const textParts = (msg.content || [])
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');

      if (textParts.trim()) {
        turns.push({
          turn: turnNumber,
          role: 'human',
          text: textParts
        });
      }
    } else if (msg.role === 'assistant') {
      // 提取精简的 assistant 信息: 简短文本 + tool 摘要
      const textParts = [];
      const toolCalls = [];

      for (const block of (msg.content || [])) {
        if (block.type === 'text' && block.text) {
          // 仅取 assistant 文本的前 200 个字符作为 context
          textParts.push(truncate(block.text, 200));
        } else if (block.type === 'toolCall') {
          // 精简 tool 调用: 名称 + 截断后的关键信息
          let summary = block.toolName;
          if (block.args) {
            if (block.args.path) {
              summary += `: ${truncate(block.args.path, 100)}`;
            } else if (block.args.command) {
              summary += `: ${truncate(block.args.command, 100)}`;
            } else {
              // 通用参数截断
              const argsStr = JSON.stringify(block.args);
              summary += `: ${truncate(argsStr, 100)}`;
            }
          }
          toolCalls.push(summary);
        }
      }

      if (textParts.length || toolCalls.length) {
        turns.push({
          turn: turnNumber,
          role: 'assistant',
          text: textParts.length ? textParts[0] : null,
          tools: toolCalls.length ? toolCalls : null
        });
      }
    } else if (msg.role === 'toolResult') {
      // 仅记录是否出现错误
      const hasError = (msg.content || []).some(c => c.isError);
      if (hasError) {
        turns.push({
          turn: turnNumber,
          role: 'tool_error',
          text: 'tool 返回了错误'
        });
      }
    }
  }

  return {
    sessionId: data.header?.id,
    timestamp: data.header?.timestamp,
    cwd: data.header?.cwd,
    turns
  };
}

// 将精简后的数据格式化为文本，供摘要器使用
function formatForSummary(condensed) {
  const lines = [];

  lines.push(`Session: ${condensed.sessionId || '未知'}`);
  lines.push(`时间: ${condensed.timestamp || '未知'}`);
  lines.push(`目录: ${condensed.cwd || '未知'}`);
  lines.push('');
  lines.push('=== 对话 ===');
  lines.push('');

  for (const turn of condensed.turns) {
    if (turn.role === 'human') {
      lines.push(`[第 ${turn.turn} 轮] HUMAN:`);
      lines.push(turn.text);
      lines.push('');
    } else if (turn.role === 'assistant') {
      lines.push(`[第 ${turn.turn} 轮] ASSISTANT（精简）:`);
      if (turn.text) {
        lines.push(`  回复: ${turn.text}`);
      }
      if (turn.tools && turn.tools.length) {
        lines.push(`  使用的 tools: ${turn.tools.join(', ')}`);
      }
      lines.push('');
    } else if (turn.role === 'tool_error') {
      lines.push(`[第 ${turn.turn} 轮] ⚠️ tool 出现错误`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// 通过 pi 生成人类视角摘要
async function generateHumanSummary(data) {
  const condensed = extractForSummary(data);
  const formatted = formatForSummary(condensed);

  const prompt = `你正在分析一份 coding agent session transcript。你的任务是总结 HUMAN（人类）做了什么，而不是 AI agent 做了什么。

请聚焦于：
1. 人类最初的目标/请求是什么？
2. 他们不得不重新提示或引导 agent 多少次？
3. 他们做了哪种引导？（纠正、澄清、改变方向、表达不满等）
4. 出问题时，人类是否需要介入？
5. 他们的指令具体还是模糊？

用第三人称写一份约 300 词的摘要（“用户要求……”，“随后他们不得不澄清……”）。
可以简要说明涉及的领域/工具作为背景，但重点放在人类的行为和体验上。

以下是精简后的 session transcript：

${formatted}`;

  try {
    const result = spawnSync('pi', [
      '--thinking', 'low',
      '--no-tools',
      '--no-session',
      '-p',
      prompt
    ], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60000
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(result.stderr || 'The pi command failed');
    }

    return result.stdout.trim();
  } catch (err) {
    throw new Error(`Failed to generate summary: ${err.message}`);
  }
}

// 主流程
async function main() {
  try {
    const gistId = extractGistId(input);

    // 先查缓存（除非传了 --no-cache）
    let data = null;
    if (!flags.has('--no-cache')) {
      data = readCache(gistId);
    }

    if (!data) {
      const html = await fetchSessionHtml(gistId);
      data = extractSessionData(html);
      writeCache(gistId, data);
    }

    if (flags.has('--header')) {
      console.log(JSON.stringify(data.header));
    } else if (flags.has('--entries')) {
      // 以 JSON lines 输出 - 每行一个 entry
      for (const entry of data.entries) {
        console.log(JSON.stringify(entry));
      }
    } else if (flags.has('--system')) {
      console.log(data.systemPrompt || '');
    } else if (flags.has('--tools')) {
      console.log(JSON.stringify(data.tools || []));
    } else if (flags.has('--human-summary')) {
      // 生成以人类为中心的摘要
      const summary = await generateHumanSummary(data);
      console.log(summary);
    } else {
      // 默认: 输出完整会话数据
      console.log(JSON.stringify(data));
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();

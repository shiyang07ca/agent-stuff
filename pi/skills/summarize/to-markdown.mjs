#!/usr/bin/env node
/**
 * 使用 `uvx markitdown` 把 URL 或本地文件转换为 Markdown。
 * 可选：使用当前默认 Pi 模型对生成的 Markdown 生成摘要。
 *
 * 说明：`markitdown` 可以自行抓取 URL；本脚本主要额外提供：
 *   - 可选的临时文件 / 指定输出路径写入
 *   - 可选的通过 `pi` 生成摘要
 *   - 添加自定义摘要 prompt/上下文的能力（强烈推荐）
 *
 * 用法:
 *   node to-markdown.mjs <url-or-path> [--out <file>] [--tmp] [--summary [prompt]] [--prompt <prompt>]
 *
 * 示例:
 *   node to-markdown.mjs https://example.com
 *   node to-markdown.mjs ./spec.pdf --tmp
 *   node to-markdown.mjs ./spec.pdf --summary "重点总结安全与合规要求。"
 *   node to-markdown.mjs ./spec.pdf --summary --prompt "提取 API endpoint 与认证细节。"
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const argv = process.argv.slice(2);

function usageAndExit(code = 1) {
  console.error('Usage: node to-markdown.mjs <url-or-path> [--out <file>] [--tmp] [--summary [prompt]] [--prompt <prompt>]');
  process.exit(code);
}

function isFlag(s) {
  return typeof s === 'string' && s.startsWith('--');
}

function isUrl(s) {
  return /^https?:\/\//i.test(s);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function safeName(s) {
  return (s || 'document').replace(/[^a-z0-9._-]+/gi, '_');
}

function getInputBasename(s) {
  if (isUrl(s)) {
    const u = new URL(s);
    const b = basename(u.pathname);
    return safeName(b || 'document');
  }
  return safeName(basename(s));
}

function makeTmpMdPath(input) {
  const dir = join(tmpdir(), 'pi-summarize-out');
  ensureDir(dir);
  const base = getInputBasename(input);
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(16).slice(2, 8);
  return join(dir, `${base}-${stamp}-${rand}.md`);
}

// --- 参数解析 ---
let input = null;
let outPath = null;
let writeTmp = false;
let doSummary = false;
let summaryPrompt = null;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];

  if (a === '--out') {
    outPath = argv[i + 1] ?? null;
    if (!outPath || isFlag(outPath)) {
      console.error('--out requires a value');
      process.exit(1);
    }
    i++;
    continue;
  }

  if (a === '--tmp') {
    writeTmp = true;
    continue;
  }

  if (a === '--prompt' || a === '--summary-prompt') {
    summaryPrompt = argv[i + 1] ?? null;
    if (!summaryPrompt || isFlag(summaryPrompt)) {
      console.error(`${a} requires a value`);
      process.exit(1);
    }
    i++;
    continue;
  }

  if (a === '--summary') {
    doSummary = true;

    // 允许: --summary "extra instructions"（仅当下一个 token 不是 flag 且已知道 input 时）
    const next = argv[i + 1];
    if (input && next && !isFlag(next) && summaryPrompt == null) {
      summaryPrompt = next;
      i++;
    }
    continue;
  }

  if (isFlag(a)) {
    console.error(`Unknown flag: ${a}`);
    usageAndExit(1);
  }

  if (!input) {
    input = a;
  } else {
    // 额外的裸参数。如果启用了 summary 且尚无 prompt，为方便起见把它当作 prompt。
    if (doSummary && summaryPrompt == null) {
      summaryPrompt = a;
    } else {
      console.error(`Unexpected argument: ${a}`);
      usageAndExit(1);
    }
  }
}

if (!input) usageAndExit(1);

function runMarkitdown(arg) {
  // 默认包含 PDF 支持，因为许多文档 URL（例如 arXiv PDF）
  // 只有在抓取后才会被识别为 PDF，因此基于扩展名切换并不可靠。
  const result = spawnSync('uvx', ['--from', 'markitdown[pdf]', 'markitdown', arg], {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024
  });

  if (result.error) {
    throw new Error(`Failed to run uvx markitdown: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(`markitdown failed to process ${arg}${stderr ? `\n${stderr}` : ''}`);
  }
  return result.stdout;
}

function summarizeWithPi(markdown, { mdPathForNote = null, extraPrompt = null } = {}) {
  const MAX_CHARS = 140_000;
  let truncated = false;
  let body = markdown;
  if (body.length > MAX_CHARS) {
    // 同时保留开头与结尾，便于生成更好的摘要。
    const head = body.slice(0, 110_000);
    const tail = body.slice(-20_000);
    body = `${head}\n\n[...已截断 ${body.length - (head.length + tail.length)} 字符...]\n\n${tail}`;
    truncated = true;
  }

  const note = mdPathForNote ? `\n\n（生成的 markdown 文件: ${mdPathForNote}）\n` : '';
  const truncNote = truncated ? '\n\n注意: 输入因过大而被截断。' : '';

  const contextBlock = extraPrompt
    ? `\n\n用户提供的上下文 / 指令（请严格遵循）：\n${extraPrompt}\n`
    : `\n\n未提供额外上下文。如果摘要看起来偏离预期，请询问用户需要关注什么（目标、受众、要提取的内容）。\n`;

  const prompt = `你正在总结一份已转换为 Markdown 的文档。${note}
${contextBlock}
请输出：
- 一段简短的高管摘要（1 段）
- 8-15 条要点，列出关键事实 / 决策 / 要求
- 一节“待解决问题 / 缺失信息”（要点列表）

保持简洁。保留重要的数字、名称和约束。
${truncNote}

--- 文档开始 (Markdown) ---
${body}
--- 文档结束 ---`;

  const result = spawnSync('pi', [
    '--thinking', 'low',
    '--no-tools',
    '--no-session',
    '-p',
    prompt
  ], {
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000
  });

  if (result.error) {
    throw new Error(`Failed to run pi: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(`pi failed${stderr ? `\n${stderr}` : ''}`);
  }
  return (result.stdout || '').trim();
}

async function main() {
  if (!isUrl(input) && !existsSync(input)) {
    throw new Error(`File not found: ${input}`);
  }

  const md = runMarkitdown(input);

  // 如果用户指定了显式输出文件，则写入该文件。
  if (outPath) {
    writeFileSync(outPath, md, 'utf-8');
  }

  // 进行摘要时我们*始终*写入一个临时 markdown 文件，并把它的路径作为提示返回。
  // 传入 --tmp 时，也写入一个临时文件。
  let tmpMdPath = null;
  if (writeTmp || doSummary) {
    tmpMdPath = makeTmpMdPath(input);
    writeFileSync(tmpMdPath, md, 'utf-8');
  }

  if (writeTmp && tmpMdPath) {
    // 仅要求临时路径时，打印路径并退出。
    if (!doSummary && !outPath) {
      console.log(tmpMdPath);
      return;
    }
  }

  if (doSummary) {
    const summary = summarizeWithPi(md, { mdPathForNote: tmpMdPath ?? outPath, extraPrompt: summaryPrompt });
    process.stdout.write(summary);
    if (tmpMdPath) {
      process.stdout.write(`\n\n[Hint: Full document Markdown saved to: ${tmpMdPath}]\n`);
    }
    return;
  }

  process.stdout.write(md);
}

main().catch(err => {
  console.error(err?.message || String(err));
  process.exit(1);
});

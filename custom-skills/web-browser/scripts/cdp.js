/**
 * 精简 CDP 客户端 - 不依赖 puppeteer，不会挂起
 */

import WebSocket from "ws";

import { getBrowserConfig } from "./browser-config.js";
import { PROTOCOL } from "../extension/wire.mjs";
import { connectExtension } from "./extension-connection.js";

function exceptionMessage(result) {
  return (
    result.exceptionDetails.exception?.description || result.exceptionDetails.text
  );
}

function remoteObjectValue(remoteObject) {
  if (!remoteObject) return undefined;
  if ("value" in remoteObject) return remoteObject.value;

  switch (remoteObject.unserializableValue) {
    case "NaN":
      return NaN;
    case "Infinity":
      return Infinity;
    case "-Infinity":
      return -Infinity;
    case "-0":
      return -0;
  }

  if (remoteObject.type === "bigint" && remoteObject.unserializableValue) {
    return BigInt(remoteObject.unserializableValue.slice(0, -1));
  }

  return undefined;
}

export async function connect(config = getBrowserConfig(), timeout = config.isolated ? 5000 : 60000) {
  if (!config.isolated) {
    const cdp = new CDP(await connectExtension(config));
    cdp.extension = true;
    cdp.on("Agent.disconnected", ({ reason }) => { cdp.disconnect(new Error(reason)); cdp.ws.terminate(); });
    try { await cdp.send("Agent.hello", { protocol: PROTOCOL }); return cdp; }
    catch (error) { cdp.close(); throw error; }
  }
  const url = await debugEndpoint(config.host, config.port, timeout);
  const cdp = await connectWebSocket(url, timeout, false);
  if (config.isolated) {
    try {
      const { findBrowserProcesses, readBrowserState } = await import("./browser-processes.js");
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
      const pid = Number(processInfo.find((item) => item.type === "browser")?.id);
      const instance = readBrowserState(config.stateFile).instances.find(
        (item) => item.pid === pid && item.port === config.port && item.userDataDir === config.profileDir && item.browserBinary === config.executable,
      );
      const owner = findBrowserProcesses([config.profileDir], [config.executable]).find(
        (item) => item.pid === pid && item.port === config.port,
      );
      if (!instance || !owner) throw new Error(`Debug endpoint :${config.port} is not the selected ${config.label} isolated browser`);
    } catch (error) { cdp.close(); throw error; }
  }
  return cdp;
}

async function debugEndpoint(host, port, timeout) {
  const response = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`Debug endpoint HTTP ${response.status}`);
  const { webSocketDebuggerUrl } = await response.json();
  if (!webSocketDebuggerUrl) throw new Error("Debug endpoint has no WebSocket URL");
  return webSocketDebuggerUrl;
}

// 仅供独立实例生命周期使用；调用者仍须核对 PID 和 profile。
export async function connectIsolatedEndpoint(host, port) {
  return connectWebSocket(await debugEndpoint(host, port, 3000), 3000, true);
}

export function connectWebSocket(url, timeout = 60000, allowBrowserClose = false) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      reject(new Error("WebSocket connection timed out; check the browser authorization prompt"));
      ws.terminate();
    }, timeout);
    ws.once("open", () => { clearTimeout(timer); resolve(new CDP(ws, allowBrowserClose)); });
    ws.once("error", (error) => { clearTimeout(timer); reject(error); });
    ws.once("close", () => { clearTimeout(timer); reject(new Error("WebSocket closed before connecting")); });
  });
}

export class CDP {
  constructor(ws, allowBrowserClose = false) {
    this.allowBrowserClose = allowBrowserClose;
    this.closed = false;
    this.ws = ws;
    this.id = 0;
    this.callbacks = new Map();
    this.sessions = new Map();
    this.eventHandlers = new Map();

    ws.on("close", () => this.disconnect(new Error("CDP disconnected")));
    ws.on("error", (error) => this.disconnect(error));
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch (error) { this.disconnect(new Error("Invalid CDP message", { cause: error })); ws.terminate(); return; }
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) {
          reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
        return;
      }

      if (msg.method) {
        this.emit(msg.method, msg.params || {}, msg.sessionId || null);
      }
    });
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) {
      this.eventHandlers.set(method, new Set());
    }
    this.eventHandlers.get(method).add(handler);
    return () => this.off(method, handler);
  }

  off(method, handler) {
    const handlers = this.eventHandlers.get(method);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) {
      this.eventHandlers.delete(method);
    }
  }

  emit(method, params, sessionId) {
    const handlers = this.eventHandlers.get(method);
    if (!handlers || handlers.size === 0) return;
    for (const handler of handlers) {
      handler(params, sessionId);
    }
  }

  send(method, params = {}, sessionId = null, timeout = 10000) {
    if (method === "Browser.close" && !this.allowBrowserClose) return Promise.reject(new Error("Browser.close is restricted to isolated lifecycle commands"));
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP disconnected"));
    return new Promise((resolve, reject) => {
      const msgId = ++this.id;
      const msg = { id: msgId, method, params };
      if (sessionId) msg.sessionId = sessionId;

      const timeoutId = setTimeout(() => {
        this.callbacks.delete(msgId);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);

      this.callbacks.set(msgId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
      });

      this.ws.send(JSON.stringify(msg), (error) => {
        if (!error) return;
        this.callbacks.get(msgId)?.reject(error);
        this.callbacks.delete(msgId);
      });
    });
  }

  async getPages() {
    const { targetInfos } = await this.send("Target.getTargets");
    return targetInfos.filter((t) => t.type === "page");
  }

  async attachToPage(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
      ...(this.extension ? { observer: this.observer === true } : {}),
    });
    return sessionId;
  }

  async evaluate(sessionId, expression, timeout = 30000) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
      timeout
    );

    if (result.exceptionDetails) {
      throw new Error(exceptionMessage(result));
    }
    return result.result?.value;
  }

  async evaluateRepl(sessionId, expression, timeout = 30000) {
    const objectGroup = `agent-eval-${Date.now()}-${Math.random()}`;

    try {
      const result = await this.send(
        "Runtime.evaluate",
        {
          expression,
          objectGroup,
          returnByValue: false,
          replMode: true,
        },
        sessionId,
        timeout
      );

      if (result.exceptionDetails) {
        throw new Error(exceptionMessage(result));
      }

      let remoteObject = result.result;
      if (remoteObject?.subtype === "promise" && remoteObject.objectId) {
        const awaited = await this.send(
          "Runtime.awaitPromise",
          {
            promiseObjectId: remoteObject.objectId,
            returnByValue: true,
          },
          sessionId,
          timeout
        );

        if (awaited.exceptionDetails) {
          throw new Error(exceptionMessage(awaited));
        }

        remoteObject = awaited.result;
      } else if (remoteObject?.objectId) {
        const cloned = await this.send(
          "Runtime.callFunctionOn",
          {
            objectId: remoteObject.objectId,
            functionDeclaration: "function() { return this; }",
            returnByValue: true,
          },
          sessionId,
          timeout
        );

        if (cloned.exceptionDetails) {
          throw new Error(exceptionMessage(cloned));
        }

        remoteObject = cloned.result;
      }

      return remoteObjectValue(remoteObject);
    } finally {
      await this.send(
        "Runtime.releaseObjectGroup",
        { objectGroup },
        sessionId,
        1000,
      ).catch(() => {});
    }
  }

  async screenshot(sessionId, timeout = 10000) {
    const { data } = await this.send(
      "Page.captureScreenshot",
      { format: "png" },
      sessionId,
      timeout
    );
    return Buffer.from(data, "base64");
  }

  async navigate(sessionId, url, timeout = 30000) {
    const result = await this.send("Page.navigate", { url }, sessionId, timeout);
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
  }

  async getFrameTree(sessionId) {
    const { frameTree } = await this.send("Page.getFrameTree", {}, sessionId);
    return frameTree;
  }

  async evaluateInFrame(sessionId, frameId, expression, timeout = 30000) {
    if (this.extension) {
      const result = await this.send("Agent.evaluateInFrame", { frameId, expression }, sessionId, timeout);
      if (result.exceptionDetails) throw new Error(exceptionMessage(result));
      return result.result?.value;
    }
    // 为 frame 创建 isolated world
    const { executionContextId } = await this.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: "cdp-eval" },
      sessionId
    );

    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        contextId: executionContextId,
        returnByValue: true,
        awaitPromise: true,
      },
      sessionId,
      timeout
    );

    if (result.exceptionDetails) {
      throw new Error(exceptionMessage(result));
    }
    return result.result?.value;
  }

  disconnect(error) {
    if (this.closed) return;
    this.closed = true;
    for (const callback of this.callbacks.values()) callback.reject(error);
    this.callbacks.clear();
    this.emit("disconnect", { error });
  }

  close() {
    this.disconnect(new Error("CDP connection closed"));
    this.ws.terminate();
  }
}

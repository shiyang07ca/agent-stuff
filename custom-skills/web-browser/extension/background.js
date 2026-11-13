import { PROTOCOL, packets, receiver } from "./wire.mjs";

const HOST = "io.agent_stuff.web_browser";
const IDLE_RELEASE_MS = 60_000;
const browser = /Edg\//.test(navigator.userAgent) ? "edge" : "chrome";
const clients = new Map();
const attached = new Map();
let port = null;
let reconnectTimer;
let reconnectDelay = 1000;
let connectionError = null;
let paused = false;
let pauseChange = null;
const initialized = chrome.storage.local.get("paused").then((state) => { paused = state.paused === true; });

function post(client, message) {
  if (!port) return;
  for (const packet of packets({ client, message })) port.postMessage(packet);
}
function event(client, method, params, sessionId) { post(client, { method, params, ...(sessionId ? { sessionId } : {}) }); }
function status() {
  return { browser, protocol: PROTOCOL, connected: !!port, paused, targets: attached.size, clients: clients.size, error: connectionError };
}
async function setPaused(value) {
  await initialized;
  if (pauseChange) throw new Error("Pause/resume is already in progress");
  pauseChange = (async () => {
    await chrome.storage.local.set({ paused: value });
    paused = value;
    if (value) await releaseAll("Browser control was paused; resume explicitly to continue");
    await chrome.action.setBadgeText({ text: paused ? "OFF" : "" });
    return status();
  })();
  try { return await pauseChange; } finally { pauseChange = null; }
}

async function targets() {
  return (await chrome.debugger.getTargets()).filter((item) => item.type === "page" && Number.isInteger(item.tabId));
}
async function targetInfo(id) {
  const target = (await targets()).find((item) => item.id === id);
  if (!target) throw new Error(`Target ${id} is unavailable; use tabs.js to list current tabs`);
  return target;
}
function info(target) { return { targetId: target.id, type: target.type, title: target.title, url: target.url }; }

async function attach(clientId, targetId, observer) {
  const client = clients.get(clientId);
  const target = await targetInfo(targetId);
  if (paused || pauseChange || client.closed || clients.get(clientId) !== client) throw new Error("Browser control is paused or disconnected");
  if ([...client.sessions.values()].includes(targetId)) throw new Error("Target already attached by this command");
  let state = attached.get(targetId);
  if (state?.closing) throw new Error("Target is being released; retry the command");
  if (state && !observer && [...state.holders.values()].some((holder) => !holder.observer)) {
    throw new Error(`Target ${targetId} is busy; another page command is running`);
  }
  if (!state) {
    state = { targetId, tabId: target.tabId, holders: new Map(), children: new Map(), closing: false };
    attached.set(targetId, state);
    state.ready = (async () => {
      await chrome.debugger.attach({ tabId: state.tabId }, "1.3");
      try {
        await chrome.debugger.sendCommand({ tabId: state.tabId }, "Target.setAutoAttach", {
          autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
          filter: [{ type: "iframe", exclude: false }, { exclude: true }],
        });
      } catch (error) { await chrome.debugger.detach({ tabId: state.tabId }); throw error; }
    })();
  }
  clearTimeout(state.releaseTimer);
  const sessionId = crypto.randomUUID();
  state.holders.set(clientId, { sessionId, observer });
  client.sessions.set(sessionId, targetId);
  try {
    await state.ready;
    if (paused || pauseChange || clients.get(clientId) !== client || attached.get(targetId) !== state || !state.holders.has(clientId)) {
      throw new Error("Browser control was interrupted while attaching");
    }
    return { sessionId };
  } catch (error) {
    await release(clientId, sessionId);
    if (!state.holders.size) await detach(state);
    throw new Error(`Cannot attach to target ${targetId}: ${error.message}`, { cause: error });
  }
}
async function release(clientId, sessionId) {
  const client = clients.get(clientId);
  const targetId = client?.sessions.get(sessionId);
  client?.sessions.delete(sessionId);
  const state = attached.get(targetId);
  if (!state) return;
  state.holders.delete(clientId);
  if (state.holders.size || state.closing) return;
  clearTimeout(state.releaseTimer);
  state.releaseTimer = setTimeout(() => {
    if (attached.get(targetId) === state && !state.holders.size) detach(state).catch(console.error);
  }, IDLE_RELEASE_MS);
}
async function detach(state) {
  clearTimeout(state.releaseTimer);
  if (state.closing) return state.closing;
  if (attached.get(state.targetId) !== state) return;
  state.closing = (async () => {
    try {
      await state.ready;
      await chrome.debugger.detach({ tabId: state.tabId });
    } catch (error) {
      // A failed attach or browser-initiated detach leaves nothing for us to detach.
      if (!/not attached|No tab|No target|Another debugger|Cannot access|closed/i.test(error.message)) console.warn("Debugger release:", error.message);
    } finally { if (attached.get(state.targetId) === state) attached.delete(state.targetId); }
  })();
  return state.closing;
}
async function disconnect(clientId) {
  const client = clients.get(clientId);
  if (!client) return;
  client.closed = true;
  await Promise.all([...client.sessions.keys()].map((session) => release(clientId, session)));
  if (clients.get(clientId) === client) clients.delete(clientId);
}
async function releaseAll(reason) {
  for (const [id, client] of clients) if (client.sessions.size) event(id, "Agent.disconnected", { reason });
  await Promise.all([...clients.keys()].map(disconnect));
  await Promise.all([...attached.values()].map(detach));
}

async function command(clientId, request) {
  await initialized;
  const { method, params = {}, sessionId } = request;
  if (method === "Agent.hello") {
    if (params.protocol !== PROTOCOL) throw new Error("Browser protocol mismatch; update and reload the extension");
    return status();
  }
  if (method === "Agent.status") return status();
  if (method === "Agent.pause") return setPaused(true);
  if (method === "Agent.resume") return setPaused(false);
  if (paused || pauseChange) throw new Error("Browser control is paused; use connection.js resume");
  const client = clients.get(clientId);
  if (!client || client.closed) throw new Error("Browser client disconnected");
  if (method === "Browser.close") throw new Error("Closing the daily browser is not supported");
  if (sessionId) {
    const targetId = client.sessions.get(sessionId);
    const state = attached.get(targetId);
    if (!state || !state.holders.has(clientId)) throw new Error("Debugger session is no longer attached");
    if (method === "Agent.evaluateInFrame") {
      const frames = await frameTrees(state);
      const frame = frames.find(({ tree }) => containsFrame(tree, params.frameId));
      if (!frame) throw new Error(`Frame ${params.frameId} is no longer available`);
      const { executionContextId } = await chrome.debugger.sendCommand(frame.source, "Page.createIsolatedWorld", { frameId: params.frameId, worldName: "cdp-eval" });
      return chrome.debugger.sendCommand(frame.source, "Runtime.evaluate", { expression: params.expression, contextId: executionContextId, returnByValue: true, awaitPromise: true });
    }
    if (method.startsWith("Agent.") || method === "Target.exposeDevToolsProtocol") throw new Error(`Unsupported page method: ${method}`);
    if (method === "Page.getFrameTree") {
      const trees = await frameTrees(state);
      const frameTree = trees[0].tree;
      for (const { tree } of trees.slice(1)) if (!containsFrame(frameTree, tree.frame.id)) {
        (frameTree.childFrames ??= []).push(tree);
      }
      return { frameTree };
    }
    if (method === "Page.navigate" && params.url?.startsWith("data:")) {
      throw new Error("The browser blocks data: navigation in an existing extension-controlled tab; omit --tab to create a data: tab");
    }
    return chrome.debugger.sendCommand({ tabId: state.tabId }, method, params);
  }
  switch (method) {
    case "Target.getTargets": return { targetInfos: (await targets()).map(info) };
    case "Target.getTargetInfo": return { targetInfo: info(await targetInfo(params.targetId)) };
    case "Target.createTarget": {
      if (params.url !== "about:blank" && !params.url?.startsWith("data:")) throw new Error("Unsupported new target URL");
      const tab = await chrome.tabs.create({ url: params.url, active: false });
      const target = (await targets()).find((item) => item.tabId === tab.id);
      if (!target) { await chrome.tabs.remove(tab.id); throw new Error("New tab has no debugger target; retry navigation"); }
      return { targetId: target.id };
    }
    case "Target.attachToTarget": return attach(clientId, params.targetId, params.observer === true);
    case "Target.detachFromTarget": await release(clientId, params.sessionId); return {};
    default: throw new Error(`Unsupported browser method: ${method}`);
  }
}

function containsFrame(tree, id) {
  return tree.frame.id === id || (tree.childFrames ?? []).some((child) => containsFrame(child, id));
}
async function frameTrees(state) {
  const sources = [{ tabId: state.tabId }, ...[...state.children.keys()].map((sessionId) => ({ tabId: state.tabId, sessionId }))];
  return Promise.all(sources.map(async (source) => ({ source, tree: (await chrome.debugger.sendCommand(source, "Page.getFrameTree")).frameTree })));
}

function receive(packet) {
  if (typeof packet.client !== "string") throw new Error("Invalid browser client");
  if (packet.disconnect) { disconnect(packet.client).catch(console.error); return; }
  const request = packet.request;
  if (!request || !Number.isInteger(request.id) || typeof request.method !== "string") throw new Error("Invalid browser request");
  if (!clients.has(packet.client)) clients.set(packet.client, { sessions: new Map(), closed: false });
  const client = clients.get(packet.client);
  const reply = (message) => { if (clients.get(packet.client) === client && !client.closed) post(packet.client, { id: request.id, ...message }); };
  command(packet.client, request).then((result) => {
    // pause clears active clients; its administrative response still has to arrive.
    if (["Agent.pause", "Agent.resume"].includes(request.method)) post(packet.client, { id: request.id, result });
    else reply({ result: result ?? {} });
  }, (error) => reply({ error: { code: -32000, message: error.message } })).catch((error) => {
    reply({ error: { code: -32000, message: error.message } });
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  for (const state of attached.values()) if (state.tabId === source.tabId) {
    if (method === "Target.attachedToTarget" && params.targetInfo.type === "iframe") state.children.set(params.sessionId, params.targetInfo.targetId);
    if (method === "Target.detachedFromTarget") state.children.delete(params.sessionId);
    // Child frame sessions are internal; don't report them as page detachment.
    if (source.sessionId || method.startsWith("Target.")) return;
    for (const [id, holder] of state.holders) event(id, method, params, holder.sessionId);
  }
});
chrome.debugger.onDetach.addListener((source, reason) => {
  // Browser cancellation is an explicit stop, including while no CLI holds the tab.
  if (reason === "canceled_by_user" && !paused && !pauseChange) setPaused(true).catch(console.error);
  for (const [targetId, state] of attached) if (state.tabId === source.tabId) {
    clearTimeout(state.releaseTimer);
    attached.delete(targetId);
    for (const [id, holder] of state.holders) {
      clients.get(id)?.sessions.delete(holder.sessionId);
      if (reason === "target_closed") event(id, "Target.detachedFromTarget", { sessionId: holder.sessionId, targetId });
      else event(id, "Agent.disconnected", { reason: `Debugger detached: ${reason}` });
    }
  }
});

async function connectHost() {
  await initialized;
  if (port) return;
  clearTimeout(reconnectTimer);
  const current = chrome.runtime.connectNative(HOST);
  port = current;
  const accept = receiver(receive);
  current.onMessage.addListener((packet) => {
    if (port !== current) return;
    reconnectDelay = 1000;
    connectionError = null;
    try { accept(packet); } catch (error) { connectionError = error.message; current.disconnect(); lostConnection(current); }
  });
  current.onDisconnect.addListener(() => {
    connectionError = chrome.runtime.lastError?.message ?? "Native bridge disconnected";
    lostConnection(current);
  });
  current.postMessage({ hello: { protocol: PROTOCOL, browser } });
  await chrome.action.setBadgeText({ text: paused ? "OFF" : "" });
}
async function lostConnection(current) {
  if (port !== current) return;
  port = null;
  await releaseAll("Native bridge disconnected");
  reconnectTimer = setTimeout(() => connectHost().catch(console.error), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  await chrome.alarms.create("reconnect", { delayInMinutes: 0.5 });
}
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "reconnect") connectHost().catch(console.error); });
chrome.runtime.onStartup.addListener(() => connectHost().catch(console.error));
chrome.runtime.onInstalled.addListener(() => connectHost().catch(console.error));
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !["status", "pause", "resume"].includes(message?.action)) return;
  (message.action === "status" ? initialized.then(status) : setPaused(message.action === "pause"))
    .then(reply, (error) => reply({ error: error.message }));
  return true;
});
connectHost().catch(console.error);

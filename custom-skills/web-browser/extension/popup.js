const text = document.querySelector("#status");
const button = document.querySelector("#toggle");
let paused = false;
async function refresh(action = "status") {
  try {
    const state = await chrome.runtime.sendMessage({ action });
    if (state.error && state.paused === undefined) throw new Error(state.error);
    paused = state.paused;
    text.textContent = `${state.browser === "edge" ? "Edge" : "Chrome"} · ${state.connected ? "桥接已连接" : "桥接未连接"}\n${paused ? "已暂停，恢复后 Agent 才能操作" : "已就绪"}\n正在控制 ${state.targets} 个标签页${state.error ? `\n${state.error}` : ""}`;
    button.textContent = paused ? "恢复控制" : "暂停控制";
    button.disabled = false;
  } catch (error) { text.textContent = error.message; }
}
button.addEventListener("click", () => refresh(paused ? "resume" : "pause"));
refresh();

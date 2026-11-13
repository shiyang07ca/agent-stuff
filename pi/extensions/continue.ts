import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 发送字面量 "continue" prompt，但绝不在运行中途 steer 或排队。 */
export default function (pi: ExtensionAPI) {
	pi.registerShortcut("shift+alt+enter", {
		description: 'Send "continue" when the agent stops',
		handler: (ctx) => {
			// Pi 重试、压缩或仍有排队消息时，isIdle() 同样保持 false，
			// 因此不会意外创建后续回合。
			if (!ctx.isIdle()) return;
			pi.sendUserMessage("continue");
		},
	});
}

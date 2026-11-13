/**
 * 自动信任由配置的 GitHub owner 拥有的已检出仓库。
 *
 * 本扩展在项目本地资源加载之前处理 pi 的 project_trust 事件。
 * 如果当前目录位于某个 git 检出内，且其 origin remote 指向
 * github.com/shiyang07ca/*，则授予并记住信任，后续 session 不再询问。
 */

import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";

const TRUSTED_GITHUB_OWNERS = new Set(["shiyang07ca"]);
const GIT_TIMEOUT_MS = 5_000;

type GitHubRepo = {
	owner: string;
	repo: string;
};

function trimGitSuffix(repo: string): string {
	return repo.replace(/\.git$/i, "");
}

function parseGitHubRemoteUrl(remoteUrl: string): GitHubRepo | null {
	const value = remoteUrl.trim();
	if (!value) {
		return null;
	}

	// 类 SCP 的 SSH 语法：git@github.com:owner/repo.git
	const scpMatch = value.match(/^(?:[^@/:\s]+@)?github\.com:([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
	if (scpMatch) {
		return {
			owner: scpMatch[1],
			repo: trimGitSuffix(scpMatch[2]),
		};
	}

	try {
		const parsed = new URL(value);
		if (parsed.hostname.toLowerCase() !== "github.com") {
			return null;
		}

		const parts = parsed.pathname
			.replace(/^\/+|\/+$/g, "")
			.split("/")
			.filter(Boolean);

		if (parts.length !== 2) {
			return null;
		}

		return {
			owner: decodeURIComponent(parts[0]),
			repo: trimGitSuffix(decodeURIComponent(parts[1])),
		};
	} catch {
		return null;
	}
}

function isTrustedGitHubRemote(remoteUrl: string): boolean {
	const repo = parseGitHubRemoteUrl(remoteUrl);
	return !!repo && TRUSTED_GITHUB_OWNERS.has(repo.owner.toLowerCase());
}

async function getOriginRemoteUrls(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	try {
		const result = await pi.exec("git", ["remote", "get-url", "--all", "origin"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		});

		if (result.code !== 0) {
			return [];
		}

		return result.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

export default function trustGitHubReposExtension(pi: ExtensionAPI): void {
	pi.on("project_trust", async (event): Promise<ProjectTrustEventResult> => {
		const originUrls = await getOriginRemoteUrls(pi, event.cwd);
		if (originUrls.length > 0 && originUrls.every(isTrustedGitHubRemote)) {
			return { trusted: "yes", remember: true };
		}

		return { trusted: "undecided" };
	});
}

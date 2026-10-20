import { beforeAll, describe, expect, it } from "bun:test";
import { StatusLineComponent } from "../src/status-line/component";
import type { StatusLineHost, StatusLineSession } from "../src/status-line/host";
import { describeSegment, renderSegment } from "../src/status-line/segments";
import type { SegmentContext, StatusLineSettings } from "../src/status-line/types";
import { initTheme, theme } from "../src/theme";

function createSession() {
	return {
		sessionFile: undefined,
		isStreaming: false,
		state: { model: undefined, messages: [] },
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as StatusLineSession;
}

const host = {
	getSettings: () => ({}) as StatusLineSettings,
	gitEnabled: () => false,
	codexResetFireworksEnabled: () => false,
	getSettingsRevision: () => 0,
	getSessionSettingsIdentity: () => null,
	getSessionSettingsRevision: () => 0,
	goalStatusInFooter: () => false,
	activeAccount: () => undefined,
	canFetchUsageReports: () => false,
	fetchUsageReports: () => Promise.resolve(null),
	calculateTokensPerSecond: () => null,
	limitMatchesActiveAccount: () => false,
	computeCompactionBoundaries: () => null,
	lookupPullRequest: () => Promise.resolve({ stdout: "", exitCode: 0 }),
	resolveActiveRepo: () => null,
} as unknown as StatusLineHost<StatusLineSession>;

const baseContext: SegmentContext = {
	session: createSession() as unknown as SegmentContext["session"],
	width: 120,
	compactThinkingLevel: false,
	options: {},
	planMode: null,
	loopMode: null,
	prewalk: null,
	goalMode: null,
	vibeMode: { enabled: true },
	vim: null,
	collab: null,
	stream: null,
	recording: false,
	usageStats: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 0,
		cost: 0,
		tokensPerSecond: null,
	},
	contextPercent: 0,
	contextTokens: 0,
	contextWindow: 0,
	autoCompactEnabled: false,
	compactionSpeculation: "idle",
	speculationBlinkOn: true,
	subagentCount: 0,
	activeMs: 0,
	turnElapsedMs: null,
	activeRepo: null,
	worktree: null,
	git: { branch: null, status: null, pr: null },
	usage: null,
};

/** Plain text of a segment, ANSI stripped (the mode segment colors its whole label). */
function segmentText(ctx: SegmentContext): string {
	const rendered = renderSegment("mode", ctx);
	// oxlint-disable-next-line no-control-regex -- stripping ANSI styling for assertions
	return rendered.content.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The native describe path renders the same facts as one span. */
function nativeSegmentText(ctx: SegmentContext): string {
	const view = describeSegment("mode", ctx);
	return (view?.spans ?? []).map(span => span.t).join("");
}

beforeAll(async () => {
	await initTheme();
});

describe("vibe chip live wait facts", () => {
	it("renders the in-flight poll on the mode segment", () => {
		const ctx = { ...baseContext, vibeWait: { onAir: 2, settled: 1, elapsedMs: 12_400 } };
		expect(segmentText(ctx)).toContain(
			`Vibe ${theme.sep.dot} 2 on air ${theme.sep.dot} 1 settled ${theme.sep.dot} 12s`,
		);
		expect(nativeSegmentText(ctx)).toBe("Vibe · 2 on air · 1 settled · 12s");
	});

	it("omits the settled fact until a turn lands, and scales the clock", () => {
		const waiting = { ...baseContext, vibeWait: { onAir: 3, settled: 0, elapsedMs: 72_000 } };
		expect(segmentText(waiting)).toContain("3 on air");
		expect(segmentText(waiting)).not.toContain("settled");
		expect(nativeSegmentText(waiting)).toBe("Vibe · 3 on air · 1m12s");
	});

	it("falls back to the plain mode chip when no poll runs", () => {
		const idle = { ...baseContext, vibeWait: null };
		expect(segmentText(idle)).toContain("Vibe");
		expect(segmentText(idle)).not.toContain("on air");
		expect(nativeSegmentText(idle)).toBe("Vibe");
	});
});

describe("status line live wait slot", () => {
	it("updates the poll in place on one fixed row and clears back to the mode chip", () => {
		const component = new StatusLineComponent(createSession(), host);
		component.setComposerStyle({ statusAttachment: "none", bottomBar: "full", bottomBarGap: false });
		component.setVibeModeStatus({ enabled: true });

		component.setVibeWaitStatus({ onAir: 2, settled: 0, elapsedMs: 4_000 });
		const first = component.render(120);
		expect(first).toHaveLength(1);
		expect(first.join("\n")).toContain("2 on air");
		expect(first.join("\n")).toContain("4s");

		component.setVibeWaitStatus({ onAir: 2, settled: 1, elapsedMs: 5_000 });
		const second = component.render(120);
		expect(second).toHaveLength(first.length);
		expect(second.join("\n")).toContain("1 settled");
		expect(second.join("\n")).toContain("5s");

		component.setVibeWaitStatus(undefined);
		const cleared = component.render(120);
		expect(cleared).toHaveLength(first.length);
		expect(cleared.join("\n")).toContain("Vibe");
		expect(cleared.join("\n")).not.toContain("on air");
	});
});

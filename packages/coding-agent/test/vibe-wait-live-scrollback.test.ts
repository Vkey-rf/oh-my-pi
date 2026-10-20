/**
 * Scrollback contract for the live `vibe_wait` wall: the poll lives in the
 * anchored dock and repaints in place, so a scrolling terminal never gains a
 * row per frame. Scrollback may only change when the dock's height does (a
 * worker appears), never because a frame updated.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Container, Text } from "@oh-my-pi/pi-tui";
import type { VibeToolDetails } from "@oh-my-pi/pi-tui/tools/vibe";

import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { withoutTerminalMultiplexer } from "../../tui/test/helpers/terminal-multiplexer";
import { VibeWaitLiveHost } from "../src/modes/controllers/vibe-wait-live";

withoutTerminalMultiplexer();

const ROWS = 24;
const COLUMNS = 100;
const TRANSCRIPT_ROWS = 8;

function wallDetails(frame: number): VibeToolDetails {
	const now = Date.now();
	return {
		op: "wait",
		screens: [
			{
				id: "w01",
				cli: "good",
				state: "running",
				model: "omni/k3:high",
				turns: 3,
				queued: 0,
				turnStartedAt: now - 4_000,
				turnMessage: "Repro worker ticking.",
				lastIntent: "Repro work",
				currentTool: "bash",
				trace: ["bash(git clone x)", "read(y)"],
				outputTail: [`frame ${frame}`],
				lastActivity: "bash",
				lastActivityAt: now,
			},
		],
		wait: { settled: [], stillRunning: ["w01"], timedOut: false, waiting: true },
	};
}

function makeHarness() {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	for (let row = 0; row < TRANSCRIPT_ROWS; row++) {
		transcript.addChild({ render: () => [`settled row ${row}`] });
	}
	const vibeWaitContainer = new Container();
	const editor = new Container();
	editor.addChild(new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, vibeWaitContainer, editor], {
		transientChrome: [editor],
		selfClearingChrome: [vibeWaitContainer],
	});
	const requestRender = () => composer.ui.requestRender();
	const host = new VibeWaitLiveHost(vibeWaitContainer, { setVibeWaitStatus() {} } as never, () => true, requestRender);
	return { terminal, scheduler, composer, host, vibeWaitContainer };
}

beforeAll(async () => {
	await initTheme(false);
});

afterAll(() => {});

describe("live vibe wall scrollback contract", () => {
	it("updates 20 frames in place without committing a row to scrollback", async () => {
		const h = makeHarness();
		h.composer.start({ playWelcomeIntro: false });
		await h.scheduler.settle(h.terminal);
		const before = h.terminal.getBufferPosition();
		const committed = h.terminal.getScrollBuffer().slice(0, before.baseY);
		const beforeFrame = h.terminal.getViewport().join("\n");
		expect(beforeFrame).toContain("settled row 0");

		let lastViewport = "";
		for (let frame = 0; frame < 20; frame++) {
			h.host.publish({ details: wallDetails(frame), onAir: 1, settled: 0, elapsedMs: 1_000 + frame * 500 });
			await h.scheduler.settle(h.terminal);
			const viewport = h.terminal.getViewport().join("\n");
			expect(h.terminal.getBufferPosition().baseY).toBe(before.baseY);
			lastViewport = viewport;
		}

		// Nothing old fell into scrollback, and the live rows did change.
		expect(h.terminal.getScrollBuffer().slice(0, before.baseY)).toEqual(committed);
		expect(lastViewport).toContain("w01");
		expect(lastViewport).not.toBe(beforeFrame);

		// The poll returned: the dock clears and the transcript is still intact.
		h.host.publish(undefined);
		await h.scheduler.settle(h.terminal);
		expect(h.vibeWaitContainer.children).toHaveLength(0);
		expect(h.terminal.getViewport().join("\n")).toContain("settled row 0");
		expect(h.terminal.getBufferPosition().baseY).toBe(before.baseY);
	});
});

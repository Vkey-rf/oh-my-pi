/**
 * The in-flight `vibe_wait` poll is live status, not history: the transcript
 * draws no row for it and the status line's vibe chip carries
 * `2 on air · 1 settled · 12s` instead. This asserts the controller wiring —
 * open on `tool_execution_start`, refresh from every progress frame (the
 * registry's `onProgress`), clear on `tool_execution_end` and as an
 * `agent_end` safety net.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const setVibeWaitStatus = vi.fn();

function createFixture() {
	const ctx = createInteractiveModeContext({
		statusLine: { setVibeWaitStatus } as never,
		isInitialized: true,
		session: {
			getToolByName: () => undefined,
			hasBuiltInTool: () => true,
		},
	});
	const controller = new EventController(ctx);
	return { controller, ctx };
}

function waitFrame(states: string[], settled: number) {
	return {
		type: "tool_execution_update" as const,
		toolCallId: "call-1",
		toolName: "vibe_wait",
		args: {},
		partialResult: {
			content: [{ type: "text", text: "" }],
			details: {
				op: "wait",
				screens: states.map((state, index) => ({ id: `w0${index}`, state, trace: [], outputTail: [], turns: 1 })),
				wait: {
					settled: Array.from({ length: settled }, (_, index) => ({
						id: `w0${index}`,
						jobId: `job-${index}`,
						status: "completed",
					})),
					stillRunning: [],
					timedOut: false,
					waiting: true,
				},
			},
		},
	};
}

describe("EventController vibe wait chip wiring", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		setVibeWaitStatus.mockClear();
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	it("opens on start, tracks each progress frame, and clears on end", async () => {
		const { controller } = createFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "vibe_wait",
			args: {},
		});
		expect(setVibeWaitStatus).toHaveBeenLastCalledWith({ onAir: 0, settled: 0, elapsedMs: expect.any(Number) });

		await controller.handleEvent(waitFrame(["running", "idle", "starting"], 0) as never);
		expect(setVibeWaitStatus).toHaveBeenLastCalledWith({ onAir: 2, settled: 0, elapsedMs: expect.any(Number) });

		await controller.handleEvent(waitFrame(["running", "idle"], 1) as never);
		expect(setVibeWaitStatus).toHaveBeenLastCalledWith({ onAir: 1, settled: 1, elapsedMs: expect.any(Number) });

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "vibe_wait",
			result: { content: [], details: { op: "wait", screens: [] } },
			isError: false,
		});
		expect(setVibeWaitStatus).toHaveBeenLastCalledWith(undefined);
	});

	it("ignores frames from a different call and forgets the chip at agent_end", async () => {
		const { controller } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "vibe_wait",
			args: {},
		});
		setVibeWaitStatus.mockClear();

		await controller.handleEvent({ ...waitFrame(["running"], 0), toolCallId: "call-other" } as never);
		expect(setVibeWaitStatus).not.toHaveBeenCalled();

		await controller.handleEvent({ ...waitFrame(["running"], 0), toolCallId: "call-1" } as never);
		expect(setVibeWaitStatus).toHaveBeenCalledTimes(1);
	});
});

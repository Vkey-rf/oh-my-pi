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
const updateVibeWaitLive = vi.fn();

function createFixture() {
	const ctx = createInteractiveModeContext({
		statusLine: { setVibeWaitStatus } as never,
		updateVibeWaitLive,
		isInitialized: true,
		session: {
			getToolByName: () => undefined,
			hasBuiltInTool: () => true,
		},
	});
	const controller = new EventController(ctx);
	return { controller, ctx };
}

const SCREEN = {
	id: "w00",
	cli: "good" as const,
	state: "running" as const,
	model: "omni/k3:high",
	turns: 1,
	queued: 0,
	turnStartedAt: Date.now() - 1_000,
	turnMessage: "ticking",
	trace: ["bash(sleep 1)"],
	outputTail: ["working"],
	lastActivity: "bash",
	lastActivityAt: Date.now(),
};

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
				screens: states.map((state, index) => ({ ...SCREEN, id: `w0${index}`, state })),
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
		updateVibeWaitLive.mockClear();
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	it("opens on start, tracks each progress frame, and clears on end", async () => {
		const { controller, ctx } = createFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "vibe_wait",
			args: {},
		});
		expect(updateVibeWaitLive).not.toHaveBeenCalled();

		// The transcript block created at start draws no rows while the poll runs.
		const blockCount = ctx.chatContainer.children.length;
		expect(ctx.chatContainer.render(120)).toHaveLength(0);

		await controller.handleEvent(waitFrame(["running", "idle", "starting"], 0) as never);
		expect(updateVibeWaitLive).toHaveBeenLastCalledWith({
			details: expect.objectContaining({ op: "wait" }),
			onAir: 2,
			settled: 0,
			elapsedMs: expect.any(Number),
		});

		await controller.handleEvent(waitFrame(["running", "idle"], 1) as never);
		expect(updateVibeWaitLive).toHaveBeenLastCalledWith({
			details: expect.objectContaining({ op: "wait" }),
			onAir: 1,
			settled: 1,
			elapsedMs: expect.any(Number),
		});

		// Twenty frames in place: the transcript never grows, the wall is republished.
		for (let frame = 0; frame < 20; frame++) {
			await controller.handleEvent(waitFrame(["running", "idle"], frame % 2) as never);
		}
		expect(ctx.chatContainer.children.length).toBe(blockCount);
		expect(ctx.chatContainer.render(120)).toHaveLength(0);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "vibe_wait",
			result: {
				content: [{ type: "text", text: "## w00 — completed" }],
				details: {
					op: "wait",
					screens: [SCREEN],
					wait: {
						settled: [{ id: "w00", jobId: "job-0", status: "completed" }],
						stillRunning: [],
						timedOut: false,
					},
				},
			},
			isError: false,
		});
		expect(updateVibeWaitLive).toHaveBeenLastCalledWith(undefined);
		// Exactly one static card survives the poll, in the block created at start.
		expect(ctx.chatContainer.children.length).toBe(blockCount);
		expect(ctx.chatContainer.render(120).length).toBeGreaterThan(0);
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
		updateVibeWaitLive.mockClear();

		await controller.handleEvent({ ...waitFrame(["running"], 0), toolCallId: "call-other" } as never);
		expect(updateVibeWaitLive).not.toHaveBeenCalled();

		await controller.handleEvent({ ...waitFrame(["running"], 0), toolCallId: "call-1" } as never);
		expect(updateVibeWaitLive).toHaveBeenCalledTimes(1);
	});
});

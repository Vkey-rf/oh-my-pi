/**
 * Repeated `wait` calls must not stack "waiting on N jobs" frames in the
 * transcript: a wait whose watched jobs are all still running stays live
 * (displaceable) and the next `wait` call replaces it — one persistent wait.
 *
 * Contracts under test:
 *  - ToolExecutionComponent: a waiting-poll result stays displaceable but
 *    finalizes like any other settled result (so it can retire as history
 *    instead of pinning the live viewport); seal() always freezes.
 *  - EventController: a follow-up `wait` call removes the tracked waiting
 *    poll from the transcript; any other tool seals it in place.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent, type ToolExecutionHandle } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { cfgDisplayShowTokenUsage } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { EMPTY_NODE } from "@oh-my-pi/pi-tui/native/describe";
import { createUsageRowBlock } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

type JobStatus = "running" | "completed" | "failed" | "cancelled";

function pollResult(statuses: JobStatus[], extra: { cancelled?: boolean; isError?: boolean } = {}) {
	return {
		content: [{ type: "text" as const, text: "" }],
		isError: extra.isError,
		details: {
			op: "wait" as const,
			jobs: statuses.map((status, i) => ({
				id: `j${i}`,
				type: "task" as const,
				status,
				label: `job ${i}`,
				durationMs: 1_000,
			})),
			...(extra.cancelled ? { cancelled: [{ id: "j0", status: "cancelled" as const }] } : {}),
		},
	};
}

/** A vibe_wait result: `wait` frames the TV wall, and only an empty `settled` list is a still-watching poll. */
function vibeWallResult(
	wait: {
		settled?: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled" }>;
		stillRunning?: string[];
		waiting?: boolean;
	} = {},
	screen: { turns?: number; lastIntent?: string } = {},
) {
	return {
		content: [{ type: "text" as const, text: "" }],
		details: {
			op: "wait" as const,
			screens: [
				{
					id: "worker",
					cli: "good" as const,
					state: "running" as const,
					turns: screen.turns ?? 1,
					queued: 0,
					trace: [] as string[],
					outputTail: [] as string[],
					...(screen.lastIntent !== undefined ? { lastIntent: screen.lastIntent } : {}),
					lastActivityAt: 0,
				},
			],
			wait: {
				settled: wait.settled ?? [],
				stillRunning: wait.stillRunning ?? ["worker"],
				timedOut: false,
				...(wait.waiting === true ? { waiting: true } : {}),
			},
		},
	};
}

function todoResult(items = ["investigate", "fix"]) {
	return {
		content: [{ type: "text" as const, text: "" }],
		details: {
			phases: [
				{
					name: "Workflow",
					tasks: items.map((content, index) => ({
						content,
						status: index === 0 ? ("in_progress" as const) : ("pending" as const),
					})),
				},
			],
			storage: "memory" as const,
		},
	};
}

function trackComponent(components: ToolExecutionComponent[], component: ToolExecutionComponent) {
	components.push(component);
	return component;
}

describe("wait block lifecycle", () => {
	const created: ToolExecutionComponent[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		// Seal everything so displaceable blocks' spinner intervals never leak
		// into later test files.
		for (const component of created.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function makeJobComponent() {
		return trackComponent(created, new ToolExecutionComponent("wait", {}, {}, undefined, uiStub));
	}

	it("keeps an all-running poll displaceable yet finalized until sealed", () => {
		const component = makeJobComponent();
		component.updateResult(pollResult(["running", "running"]), false);

		expect(component.isDisplaceableBlock()).toBe(true);
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		component.seal();
		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("job 0");
	});

	it("finalizes a poll that observed a settled job", () => {
		const component = makeJobComponent();
		component.updateResult(pollResult(["completed", "running"]), false);

		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("finalizes a poll that carried cancel outcomes or an error", () => {
		const cancelled = makeJobComponent();
		cancelled.updateResult(pollResult(["running"], { cancelled: true }), false);
		expect(cancelled.isDisplaceableBlock()).toBe(false);

		const errored = makeJobComponent();
		errored.updateResult(pollResult(["running"], { isError: true }), false);
		expect(errored.isDisplaceableBlock()).toBe(false);
		expect(errored.isTranscriptBlockFinalized()).toBe(true);
	});

	it("keeps successful todo snapshots displaceable yet finalized", () => {
		const component = trackComponent(
			created,
			new ToolExecutionComponent("todo", { op: "view" }, {}, undefined, uiStub),
		);
		component.updateResult(todoResult(), false);

		expect(component.isDisplaceableBlock()).toBe(true);
		expect(component.isTranscriptBlockFinalized()).toBe(true);

		component.seal();
		expect(component.isDisplaceableBlock()).toBe(false);
		expect(component.isTranscriptBlockFinalized()).toBe(true);
	});

	it("never marks ordinary non-refresh tools displaceable", () => {
		const component = trackComponent(
			created,
			new ToolExecutionComponent("bash", { command: "ls" }, {}, undefined, uiStub),
		);
		component.updateResult(pollResult(["running"]), false);
		expect(component.isDisplaceableBlock()).toBe(false);
	});

	it("keeps a still-watching vibe wall displaceable and finalizes a settled one", () => {
		const waiting = trackComponent(created, new ToolExecutionComponent("vibe_wait", {}, {}, undefined, uiStub));
		waiting.updateResult(vibeWallResult(), false);
		expect(waiting.isDisplaceableBlock()).toBe(true);
		expect(waiting.isTranscriptBlockFinalized()).toBe(true);

		const settled = trackComponent(created, new ToolExecutionComponent("vibe_wait", {}, {}, undefined, uiStub));
		settled.updateResult(
			vibeWallResult({ settled: [{ id: "worker", jobId: "job-7", status: "completed" }], stillRunning: [] }),
			false,
		);
		expect(settled.isDisplaceableBlock()).toBe(false);
	});

	it("renders nothing for unresolved vibe waits, and one card when a turn settles", () => {
		const wall = trackComponent(created, new ToolExecutionComponent("vibe_wait", {}, {}, undefined, uiStub));
		for (let tick = 1; tick <= 15; tick++) {
			wall.updateResult(vibeWallResult({ waiting: true }, { turns: tick, lastIntent: `tick ${tick}` }), true);
			// A progress frame draws no rows: a growing live wall is what scrollback
			// retirement used to turn into one appended copy per tick.
			expect(wall.render(120)).toEqual([]);
			expect(wall.describe()).toBe(EMPTY_NODE);
		}

		// A finished poll that only saw turns still running is status, not history.
		wall.updateResult(vibeWallResult(), false);
		expect(wall.render(120)).toEqual([]);
		expect(wall.describe()).toBe(EMPTY_NODE);

		wall.updateResult(
			vibeWallResult({ settled: [{ id: "worker", jobId: "job-7", status: "completed" }], stillRunning: [] }),
			false,
		);
		expect(Bun.stripANSI(wall.render(120).join("\n"))).toContain("worker");
		expect(wall.isTranscriptBlockFinalized()).toBe(true);
	});
});

describe("EventController displaces consecutive waiting polls", () => {
	const created: ToolExecutionComponent[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		for (const component of created.splice(0)) component.seal();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function createFixture() {
		const pendingTools = new Map<string, ToolExecutionHandle>();
		const ctx = createInteractiveModeContext({ pendingTools });
		const children = ctx.chatContainer.children;
		return { controller: new EventController(ctx), children, pendingTools };
	}

	async function runPoll(controller: EventController, children: Component[], toolCallId: string) {
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId,
			toolName: "wait",
			args: {},
		});
		const component = children[children.length - 1] as ToolExecutionComponent;
		trackComponent(created, component);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "wait",
			result: pollResult(["running", "running"]),
			isError: false,
		});
		return component;
	}

	async function runVibePoll(
		controller: EventController,
		children: Component[],
		toolCallId: string,
		result = vibeWallResult(),
	) {
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId,
			toolName: "vibe_wait",
			args: {},
		});
		const component = children[children.length - 1] as ToolExecutionComponent;
		trackComponent(created, component);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "vibe_wait",
			result,
			isError: false,
		});
		return component;
	}

	async function runTodo(controller: EventController, children: Component[], toolCallId: string, items?: string[]) {
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId,
			toolName: "todo",
			args: { op: "view" },
		});
		const component = children[children.length - 1] as ToolExecutionComponent;
		trackComponent(created, component);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName: "todo",
			result: todoResult(items),
			isError: false,
		});
		return component;
	}

	it("removes the previous waiting poll when the next wait call starts", async () => {
		const { controller, children } = createFixture();

		const first = await runPoll(controller, children, "t1");
		expect(children).toContain(first);

		const second = await runPoll(controller, children, "t2");

		// The stale "waiting" frame is gone; only the fresh poll remains.
		expect(children).not.toContain(first);
		expect(children).toContain(second);
		// The displaced block is sealed so its spinner interval is stopped.
		expect(first.isTranscriptBlockFinalized()).toBe(true);
	});

	it("keeps a waiting snapshot beside its completed turn's usage when the next wait starts", async () => {
		const { controller, children } = createFixture();
		const first = await runPoll(controller, children, "t1");
		const metrics = createUsageRowBlock({
			input: 4242,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4249,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		children.push(metrics);
		await runPoll(controller, children, "t2");
		expect(children).toContain(first);
		expect(children.indexOf(first)).toBe(children.indexOf(metrics) - 1);
		expect(Bun.stripANSI(first.render(100).join("\n"))).toContain("job 0");
		expect(Bun.stripANSI(metrics.render(100).join("\n"))).toContain("4.2K");
	});

	it("seals the waiting poll in place when a different tool runs next", async () => {
		const { controller, children } = createFixture();

		const poll = await runPoll(controller, children, "t1");
		expect(poll.isDisplaceableBlock()).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "bash",
			args: { command: "ls" },
		});
		trackComponent(created, children[children.length - 1] as ToolExecutionComponent);

		// The poll frame stays — it is final history now, not displaceable.
		expect(children).toContain(poll);
		expect(poll.isTranscriptBlockFinalized()).toBe(true);
		expect(poll.isDisplaceableBlock()).toBe(false);
	});

	it("removes the previous todo snapshot when a later todo update lands in the same turn", async () => {
		const { controller, children } = createFixture();

		const first = await runTodo(controller, children, "todo-1", ["plan", "read"]);
		expect(children).toContain(first);
		expect(first.isDisplaceableBlock()).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "true" },
		});
		const bash = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);
		expect(children).toContain(first);
		expect(children).toContain(bash);

		const second = await runTodo(controller, children, "todo-2", ["fix", "test"]);

		expect(children).not.toContain(first);
		expect(children).toContain(bash);
		expect(children).toContain(second);
		expect(first.isTranscriptBlockFinalized()).toBe(true);
	});

	it("displaces a prior todo snapshot when a streamed second todo lands a successful result", async () => {
		const { controller, children, pendingTools } = createFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "todo-1",
			toolName: "todo",
			args: { op: "view" },
		});
		const first = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);

		const second = trackComponent(created, new ToolExecutionComponent("todo", { op: "view" }, {}, undefined, uiStub));
		children.push(second);
		pendingTools.set("todo-2", second);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-1",
			toolName: "todo",
			result: todoResult(["plan", "read"]),
			isError: false,
		});
		expect(first.isDisplaceableBlock()).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "true" },
		});
		const bash = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);
		expect(children).toContain(first);
		expect(children).toContain(second);
		expect(children).toContain(bash);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "todo-2",
			toolName: "todo",
			args: { op: "view" },
		});

		// Start alone is no longer enough — the prior snapshot stays so a failed
		// follow-up cannot strand the user without a current todo panel.
		expect(children).toContain(first);
		expect(first.isDisplaceableBlock()).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-2",
			toolName: "todo",
			result: todoResult(["fix", "test"]),
			isError: false,
		});

		expect(children).not.toContain(first);
		expect(children).toContain(second);
		expect(children).toContain(bash);
		expect(first.isTranscriptBlockFinalized()).toBe(true);
	});

	it("keeps the prior todo snapshot when a follow-up todo errors", async () => {
		const { controller, children } = createFixture();

		const first = await runTodo(controller, children, "todo-1", ["plan", "read"]);
		expect(children).toContain(first);
		expect(first.isDisplaceableBlock()).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "todo-2",
			toolName: "todo",
			args: { op: "view" },
		});
		const errored = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-2",
			toolName: "todo",
			result: { content: [{ type: "text", text: "Phase missing" }], details: undefined, isError: true },
			isError: true,
		});

		expect(children).toContain(first);
		expect(children).toContain(errored);
		expect(first.isDisplaceableBlock()).toBe(true);
	});

	it("does not displace a poll that observed completions", async () => {
		const { controller, children } = createFixture();

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "wait",
			args: {},
		});
		const settled = trackComponent(created, children[children.length - 1] as ToolExecutionComponent);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "wait",
			result: pollResult(["completed", "running"]),
			isError: false,
		});

		const next = await runPoll(controller, children, "t2");

		// A poll that carried real results is kept as history.
		expect(children).toContain(settled);
		expect(children).toContain(next);
	});

	it("removes the previous vibe wall when the next vibe_wait starts", async () => {
		const { controller, children } = createFixture();

		const first = await runVibePoll(controller, children, "v1");
		expect(children).toContain(first);
		expect(first.isDisplaceableBlock()).toBe(true);

		const second = await runVibePoll(controller, children, "v2");

		// The stale wall frame is gone; only the fresh wall remains.
		expect(children).not.toContain(first);
		expect(children).toContain(second);
		expect(first.isTranscriptBlockFinalized()).toBe(true);
	});

	it("keeps a vibe wall that observed a settled turn beside the next poll", async () => {
		const { controller, children } = createFixture();
		const settled = await runVibePoll(
			controller,
			children,
			"v1",
			vibeWallResult({ settled: [{ id: "worker", jobId: "job-7", status: "completed" }], stillRunning: [] }),
		);

		const next = await runVibePoll(controller, children, "v2");

		// A wall that settled a turn is real history, not a supersedable poll.
		expect(children).toContain(settled);
		expect(children).toContain(next);
	});

	it("keeps one quiet card across intra-call vibe progress frames", async () => {
		const { controller, children } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "v1",
			toolName: "vibe_wait",
			args: {},
		});
		const wall = children[children.length - 1] as ToolExecutionComponent;
		trackComponent(created, wall);

		for (let tick = 1; tick <= 15; tick++) {
			await controller.handleEvent({
				type: "tool_execution_update",
				toolCallId: "v1",
				toolName: "vibe_wait",
				args: {},
				partialResult: vibeWallResult({ waiting: true }, { turns: tick, lastIntent: `tick ${tick}` }),
			});
			// Progress frames add no block and draw no rows; the poll's card stays
			// quiet until a wait observes a settle.
			expect(children).toHaveLength(1);
			expect(children[0]).toBe(wall);
			expect(wall.render(120)).toEqual([]);
		}

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "v1",
			toolName: "vibe_wait",
			result: vibeWallResult(),
			isError: false,
		});
		expect(children).toHaveLength(1);
		// The finished poll saw no settle either, so its card still draws nothing.
		expect(wall.render(120)).toEqual([]);
		expect(wall.isTranscriptBlockFinalized()).toBe(true);
	});

	it("renders no blocks for completed polls that never settle", async () => {
		const { controller, children } = createFixture();
		for (let index = 1; index <= 5; index++) await runVibePoll(controller, children, `v${index}`);
		expect(children.filter(child => child.render(120).length > 0)).toHaveLength(0);
	});

	it("paints a wall only for waits that observed a settle", async () => {
		const { controller, children } = createFixture();
		const settledFrame = () =>
			vibeWallResult({ settled: [{ id: "worker", jobId: "job-7", status: "completed" }], stillRunning: [] });

		const first = await runVibePoll(controller, children, "v1", settledFrame());
		expect(first.render(120).length).toBeGreaterThan(0);
		expect(children.filter(child => child.render(120).length > 0)).toHaveLength(1);

		// An unresolved poll between settled waits adds no visible block.
		await runVibePoll(controller, children, "v2");
		expect(children.filter(child => child.render(120).length > 0)).toHaveLength(1);

		const second = await runVibePoll(controller, children, "v3", settledFrame());
		expect(second.render(120).length).toBeGreaterThan(0);
		expect(children.filter(child => child.render(120).length > 0)).toHaveLength(2);
	});
});

describe("#12248 completed wait turn replay", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		cfgDisplayShowTokenUsage.set(settings, true);
		await initTheme();
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	function waitTurn(id: string, input: number): AgentMessage[] {
		return [
			{
				role: "assistant",
				content: [{ type: "toolCall", id, name: "wait", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input,
					output: 7,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: input + 7,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "wait",
				...pollResult(["running"]),
				isError: false,
				timestamp: Date.now(),
			},
		] satisfies AgentMessage[];
	}

	it.each(["session", "transcript"] as const)("retains each wait with its original metrics in %s replay", mode => {
		const messages = [...waitTurn("w1", 4242), ...waitTurn("w2", 2121)];
		let children: Component[];
		if (mode === "session") {
			const ctx = createInteractiveModeContext({ settings: Settings.isolated({ "display.showTokenUsage": true }) });
			const helpers = new UiHelpers(ctx);
			ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
			helpers.renderSessionContext({ messages } as SessionContext);
			children = ctx.chatContainer.children;
		} else {
			const builder = new ChatTranscriptBuilder({ ui: uiStub, cwd: process.cwd(), requestRender() {} });
			builder.rebuild(
				messages.map((message, i) => ({
					type: "message" as const,
					id: `m${i}`,
					parentId: i ? `m${i - 1}` : null,
					timestamp: new Date(0).toISOString(),
					message,
				})),
			);
			children = builder.container.children;
		}
		const polls = children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		for (const poll of polls) poll.seal();
		expect(polls).toHaveLength(2);
		const output = children.map(child => Bun.stripANSI(child.render(120).join("\n")));
		for (const [i, label] of ["4.2K", "2.1K"].entries()) {
			const pollIndex = children.indexOf(polls[i]);
			expect(output[pollIndex]).toContain("job 0");
			expect(output[pollIndex + 1]).toContain(label);
			expect(output.filter(text => text.includes(label))).toHaveLength(1);
		}
	});
});

describe("UiHelpers.renderSessionContext collapses repeated todo snapshots", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("removes the earlier todo snapshot when an assistant message replays two todo calls", () => {
		const ctx = createInteractiveModeContext();
		const chatContainer = ctx.chatContainer;
		const helpers = new UiHelpers(ctx);
		ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);

		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "todo-1", name: "todo", arguments: { op: "view" } },
				{ type: "toolCall", id: "todo-2", name: "todo", arguments: { op: "view" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const firstResult = {
			role: "toolResult",
			toolCallId: "todo-1",
			toolName: "todo",
			content: [{ type: "text", text: "" }],
			details: todoResult(["plan", "read"]).details,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const secondResult = {
			role: "toolResult",
			toolCallId: "todo-2",
			toolName: "todo",
			content: [{ type: "text", text: "" }],
			details: todoResult(["fix", "test"]).details,
			timestamp: Date.now(),
		} as unknown as AgentMessage;

		helpers.renderSessionContext({ messages: [assistant, firstResult, secondResult] } as SessionContext);

		const todos = chatContainer.children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		// Only the latest todo snapshot survives the rebuild; the trailing one is
		// sealed as final history by the end-of-rebuild flush.
		expect(todos).toHaveLength(1);
		expect(todos[0].isTranscriptBlockFinalized()).toBe(true);
	});

	it("hands the trailing todo snapshot to the controller during mid-turn rebuild", () => {
		const ctx = createInteractiveModeContext({ session: { isStreaming: true } });
		const chatContainer = ctx.chatContainer;
		const helpers = new UiHelpers(ctx);
		ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
		const eventController = new EventController(ctx);
		ctx.eventController = eventController;
		const inheritDisplaceableTodo = vi.spyOn(eventController, "inheritDisplaceableTodo");

		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant = {
			role: "assistant",
			content: [{ type: "toolCall", id: "todo-1", name: "todo", arguments: { op: "view" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		const result = {
			role: "toolResult",
			toolCallId: "todo-1",
			toolName: "todo",
			content: [{ type: "text", text: "" }],
			details: todoResult(["plan", "read"]).details,
			timestamp: Date.now(),
		} as unknown as AgentMessage;

		helpers.renderSessionContext({ messages: [assistant, result] } as SessionContext);

		const todos = chatContainer.children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		expect(todos).toHaveLength(1);
		// Mid-turn rebuild hands the live tail back to the controller — the
		// snapshot stays displaceable so a follow-up `todo` event replaces it
		// instead of stacking another panel.
		expect(inheritDisplaceableTodo).toHaveBeenCalledTimes(1);
		expect(inheritDisplaceableTodo).toHaveBeenCalledWith(todos[0]);
		expect(todos[0].canBeDisplacedBy("todo")).toBe(true);
		expect(todos[0].isTranscriptBlockFinalized()).toBe(true);
	});
});

describe("UiHelpers.renderSessionContext collapses repeated vibe walls", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("renders no wall for a 14-poll session that never settles", () => {
		const ctx = createInteractiveModeContext();
		const chatContainer = ctx.chatContainer;
		const helpers = new UiHelpers(ctx);
		ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);

		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const callIds = Array.from({ length: 14 }, (_, i) => `v${i + 1}`);
		// Each poll is its own assistant turn + tool result, like a real vibe session.
		const messages = callIds.flatMap(
			id =>
				[
					{
						role: "assistant",
						content: [{ type: "toolCall", id, name: "vibe_wait", arguments: {} }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4-5",
						stopReason: "stop",
						usage,
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: id,
						toolName: "vibe_wait",
						...vibeWallResult(),
						isError: false,
						timestamp: Date.now(),
					},
				] as unknown as AgentMessage[],
		);

		helpers.renderSessionContext({ messages } as SessionContext);

		const walls = chatContainer.children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		// No poll observed a settle, so none of them is transcript content.
		expect(walls.filter(wall => wall.render(120).length > 0)).toHaveLength(0);
	});

	it("replays exactly one wall for the wait that observed a settle", () => {
		const ctx = createInteractiveModeContext();
		const chatContainer = ctx.chatContainer;
		const helpers = new UiHelpers(ctx);
		ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);

		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const results = [
			vibeWallResult(),
			vibeWallResult({ settled: [{ id: "worker", jobId: "job-7", status: "completed" }], stillRunning: [] }),
			vibeWallResult(),
		];
		const messages = results.flatMap((result, index) => {
			const id = `v${index + 1}`;
			return [
				{
					role: "assistant",
					content: [{ type: "toolCall", id, name: "vibe_wait", arguments: {} }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "stop",
					usage,
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: id,
					toolName: "vibe_wait",
					...result,
					isError: false,
					timestamp: Date.now(),
				},
			] as unknown as AgentMessage[];
		});

		helpers.renderSessionContext({ messages } as SessionContext);

		const walls = chatContainer.children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		const visible = walls.filter(wall => wall.render(120).length > 0);
		expect(visible).toHaveLength(1);
		expect(Bun.stripANSI(visible[0].render(120).join("\n"))).toContain("worker");
		expect(visible[0].isTranscriptBlockFinalized()).toBe(true);
	});
});

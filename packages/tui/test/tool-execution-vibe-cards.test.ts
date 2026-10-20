import { beforeAll, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "../src/chat/tool-execution";
import { EMPTY_NODE } from "../src/native/describe";
import { initTheme } from "../src/theme";

const ui = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
};

const screen = {
	id: "w01",
	cli: "good" as const,
	state: "running" as const,
	model: "omni/k3:high",
	turns: 2,
	queued: 0,
	turnStartedAt: Date.now() - 4_000,
	turnMessage: "Repro worker ticking.",
	lastIntent: "Repro work",
	trace: ["bash(sleep 1)"],
	outputTail: ["working"],
	lastActivity: "bash",
	lastActivityAt: Date.now(),
};

function build(name: string, args: unknown) {
	return new ToolExecutionComponent(name, args, { useBuiltInRenderer: true }, undefined, ui as never, "C:/tmp");
}

function rowsFor(name: string, args: unknown, result: { details?: unknown; partial?: boolean }): number {
	const component = build(name, args);
	component.updateResult({ content: [{ type: "text", text: "frame" }], details: result.details }, result.partial ?? false);
	return component.render(120).length;
}

function nativeFor(name: string, args: unknown, result: { details?: unknown; partial?: boolean }) {
	const component = build(name, args);
	component.updateResult({ content: [{ type: "text", text: "frame" }], details: result.details }, result.partial ?? false);
	return component.describe(undefined as never);
}

const waitArgs = { sessions: ["w01"], timeout: 30 };
const settledFrame = {
	op: "wait",
	screens: [screen],
	wait: {
		settled: [{ id: "w01", jobId: "job-1", status: "completed" }],
		stillRunning: [],
		timedOut: false,
	},
};
const waitingFrame = {
	op: "wait",
	screens: [screen],
	wait: { settled: [], stillRunning: ["w01"], timedOut: false, waiting: true },
};
const timedOutFrame = {
	op: "wait",
	screens: [screen],
	wait: { settled: [], stillRunning: ["w01"], timedOut: true, waiting: false },
};

beforeAll(async () => {
	await initTheme();
});

describe("vibe cards in the transcript", () => {
	it("draws no rows for an in-flight poll on either render path", () => {
		expect(rowsFor("vibe_wait", waitArgs, { details: waitingFrame, partial: true })).toBe(0);
		expect(nativeFor("vibe_wait", waitArgs, { details: waitingFrame, partial: true })).toBe(EMPTY_NODE);
	});

	it("draws one card for a wait that observed a settle", () => {
		expect(rowsFor("vibe_wait", waitArgs, { details: settledFrame })).toBeGreaterThan(0);
		expect(nativeFor("vibe_wait", waitArgs, { details: settledFrame })).not.toBe(EMPTY_NODE);
	});

	it("draws nothing for a wait that timed out with no settle", () => {
		expect(rowsFor("vibe_wait", waitArgs, { details: timedOutFrame })).toBe(0);
		expect(nativeFor("vibe_wait", waitArgs, { details: timedOutFrame })).toBe(EMPTY_NODE);
	});

	it("keeps the explicit list roster and hides the control-plane receipts", () => {
		const listFrame = { op: "list", screens: [screen] };
		expect(rowsFor("vibe_list", {}, { details: listFrame })).toBeGreaterThan(0);
		expect(nativeFor("vibe_list", {}, { details: listFrame })).not.toBe(EMPTY_NODE);

		for (const name of ["vibe_spawn", "vibe_send", "vibe_kill"]) {
			const args = name === "vibe_spawn" ? { cli: "good", prompt: "go" } : { session: "w01", message: "hi" };
			expect(rowsFor(name, args, { details: { op: "x", screens: [] } })).toBe(0);
			expect(nativeFor(name, args, { details: { op: "x", screens: [] } })).toBe(EMPTY_NODE);
		}
	});

	it("leaves ordinary tool cards untouched", () => {
		expect(rowsFor("read", { path: "package.json" }, { details: {} })).toBeGreaterThan(0);
	});
});

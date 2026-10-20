/**
 * Live host for an in-flight `vibe_wait`: the wall lives in the anchored dock
 * (mutable, repainted in place) and never in the transcript. The status chip is
 * only the fallback when the dock is not mounted. A poll that returns leaves the
 * dock empty; the transcript card is appended by the transcript path.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { VibeToolDetails } from "@oh-my-pi/pi-tui/tools/vibe";

import { VibeWaitHudComponent, VibeWaitLiveHost } from "../src/modes/controllers/vibe-wait-live";

function detailsWith(tail: string, settled = 0): VibeToolDetails {
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
				turnStartedAt: Date.now() - 4_000,
				turnMessage: "Repro worker ticking.",
				lastIntent: "Repro work",
				currentTool: "bash",
				trace: ["bash(git clone x)", "read(y)"],
				outputTail: [tail],
				lastActivity: "bash",
				lastActivityAt: Date.now(),
			},
		],
		wait: {
			settled: Array.from({ length: settled }, (_, index) => ({
				id: `w0${index}`,
				jobId: `job-${index}`,
				status: "completed" as const,
			})),
			stillRunning: ["w01"],
			timedOut: false,
			waiting: true,
		},
	};
}

function updateFor(tail: string, settled = 0, elapsedMs = 4_000) {
	const details = detailsWith(tail, settled);
	return { details, onAir: 1, settled, elapsedMs };
}

function createHost(dockMounted: boolean) {
	const container = new Container();
	const statusLine = { setVibeWaitStatus: vi.fn() };
	const requestRender = vi.fn();
	const host = new VibeWaitLiveHost(container, statusLine as never, () => dockMounted, requestRender);
	return { host, container, statusLine, requestRender };
}

beforeAll(async () => {
	await initTheme(false);
});

describe("VibeWaitHudComponent", () => {
	it("paints the wall and describes it natively", () => {
		const hud = new VibeWaitHudComponent(detailsWith("cloning…"));
		const rows = hud.render(100).join("\n");
		expect(rows.length).toBeGreaterThan(0);
		// oxlint-disable-next-line no-control-regex -- stripping ANSI styling for assertions
		const plain = rows.replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("vibe wait");
		expect(plain).toContain("w01");

		const described = hud.describe();
		const text = JSON.stringify(described);
		expect(text).toContain("Vibe");
		expect(text).toContain("w01");
	});

	it("repaints the same component when the frame changes", () => {
		const hud = new VibeWaitHudComponent(detailsWith("first"));
		const strip = (text: string): string =>
			// oxlint-disable-next-line no-control-regex -- stripping ANSI styling for assertions
			text.replace(/\x1b\[[0-9;]*m/g, "");
		const before = strip(hud.render(100).join("\n"));
		hud.update(detailsWith("second"));
		expect(strip(hud.render(100).join("\n"))).not.toBe(before);
	});
});

describe("VibeWaitLiveHost docked", () => {
	it("keeps one mutable child across 20 frames and never touches the chip", () => {
		const { host, container, statusLine, requestRender } = createHost(true);

		host.publish(updateFor("frame-0"));
		const mounted = container.children[0];
		expect(container.children).toHaveLength(1);
		expect(mounted).toBeInstanceOf(VibeWaitHudComponent);
		const firstRows = container.render(100).join("\n");

		for (let frame = 1; frame <= 20; frame++) {
			host.publish(updateFor(`frame-${frame}`, frame % 2, 1_000 + frame * 500));
			expect(container.children).toHaveLength(1);
			expect(container.children[0]).toBe(mounted);
		}
		expect(container.render(100).join("\n")).not.toBe(firstRows);
		expect(statusLine.setVibeWaitStatus).not.toHaveBeenCalledWith(expect.objectContaining({ onAir: 1 }));
		expect(requestRender).toHaveBeenCalledTimes(21);
	});

	it("drops the widget when the poll returns", () => {
		const { host, container } = createHost(true);
		host.publish(updateFor("cloning…"));
		expect(container.children).toHaveLength(1);
		host.publish(undefined);
		expect(container.children).toHaveLength(0);
		expect(container.render(100)).toHaveLength(0);
	});
});

describe("VibeWaitLiveHost fallback", () => {
	it("mirrors the poll into the status chip when the dock is not mounted", () => {
		const { host, container, statusLine } = createHost(false);
		host.publish(updateFor("cloning…", 1, 12_000));
		expect(container.children).toHaveLength(0);
		expect(statusLine.setVibeWaitStatus).toHaveBeenLastCalledWith({ onAir: 1, settled: 1, elapsedMs: 12_000 });

		host.publish(undefined);
		expect(statusLine.setVibeWaitStatus).toHaveBeenLastCalledWith(undefined);
	});
});

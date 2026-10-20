/**
 * Live host for the in-flight `vibe_wait` poll.
 *
 * A poll loop must never become transcript history: every block that retires to
 * native scrollback is immutable, so a wall frame appended per poll (or per
 * tick) piles up instead of updating. The anchored live dock is the mutable
 * surface — one component mutated in place for the whole call, dropped when the
 * poll returns. Only a real event (a settle, a failure, an explicit
 * `vibe_list`) reaches the transcript afterwards.
 *
 * When the dock is not mounted (headless, or before the TUI finishes init) the
 * status line's vibe chip carries the poll instead, so the same information
 * survives without a live wall.
 */
import type { Component, Container } from "@oh-my-pi/pi-tui";
import { SPINNER_ADVANCE_MS, theme } from "@oh-my-pi/pi-tui";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { describeVibeWaitWall, renderVibeWaitWall, type VibeToolDetails } from "@oh-my-pi/pi-tui/tools/vibe";

/** One progress frame of an in-flight `vibe_wait`, with its derived counts. */
export interface VibeWaitLiveUpdate {
	readonly details: VibeToolDetails;
	/** Workers with a turn in flight right now. */
	readonly onAir: number;
	/** Turns observed settling while this wait has been blocked. */
	readonly settled: number;
	/** How long this wait has been blocked. */
	readonly elapsedMs: number;
}

/**
 * The TV wall, rendered for a host outside the transcript. Each update replaces
 * the details; the next paint draws the new frame in place.
 */
export class VibeWaitHudComponent implements Component {
	#details: VibeToolDetails;
	#wall: Component | undefined;
	#wallDetails: VibeToolDetails | undefined;

	constructor(details: VibeToolDetails) {
		this.#details = details;
	}

	update(details: VibeToolDetails): void {
		this.#details = details;
	}

	render(width: number): readonly string[] {
		if (!this.#wall || this.#wallDetails !== this.#details) {
			const frames = Math.max(1, theme.spinnerFrames.length);
			const spinnerFrame = Math.floor(Date.now() / SPINNER_ADVANCE_MS) % frames;
			this.#wall = renderVibeWaitWall(this.#details, theme, spinnerFrame);
			this.#wallDetails = this.#details;
		}
		return this.#wall.render(width);
	}

	describe(): NativeNode {
		return describeVibeWaitWall(this.#details);
	}

	invalidate(): void {
		this.#wall = undefined;
	}
}

/** Publishes poll frames to the docked wall, or to the status chip when the dock is unavailable. */
export class VibeWaitLiveHost {
	constructor(
		private readonly container: Container,
		private readonly statusLine: StatusLineComponent,
		/** Whether the anchored dock is mounted and painted this frame. */
		private readonly dockMounted: () => boolean,
		private readonly requestRender: () => void,
	) {}

	publish(update: VibeWaitLiveUpdate | undefined): void {
		if (!this.dockMounted()) {
			this.clear();
			this.statusLine.setVibeWaitStatus(
				update ? { onAir: update.onAir, settled: update.settled, elapsedMs: update.elapsedMs } : undefined,
			);
			return;
		}
		// The wall is the live surface here; a status chip would duplicate it.
		this.statusLine.setVibeWaitStatus(undefined);
		if (!update) {
			this.clear();
			this.requestRender();
			return;
		}
		const hud = this.container.children[0];
		if (hud instanceof VibeWaitHudComponent) hud.update(update.details);
		else {
			this.container.clear();
			this.container.addChild(new VibeWaitHudComponent(update.details));
		}
		this.requestRender();
	}

	/** Drop the widget: poll returned, aborted, session switched, or teardown. */
	clear(): void {
		if (this.container.children.length === 0) return;
		this.container.clear();
		this.requestRender();
	}
}

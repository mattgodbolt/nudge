/** Distance, in px, the list must be pulled (after damping) before letting go refreshes. */
export const PULL_THRESHOLD = 72;
const MAX_PULL = 130;
const DAMPING = 0.5;
/** Movement below this is a tap or a scroll jitter, not a pull. */
const DEADZONE = 8;

/**
 * Tracks one pull-down gesture. It only starts when the scroller is already at the very top, so ordinary scrolling
 * back up the list never refreshes by accident, and a mostly-sideways drag (a swipe) is ignored.
 */
export class PullTracker {
  #startY = 0;
  #startX = 0;
  #active = false;
  #pulling = false;
  distance = 0;

  start(x: number, y: number, scrollTop: number): void {
    this.#active = scrollTop <= 0;
    this.#pulling = false;
    this.#startX = x;
    this.#startY = y;
    this.distance = 0;
  }

  /** Returns the damped pull distance (0 while it is not a pull). */
  move(x: number, y: number): number {
    if (!this.#active) return 0;
    const dy = y - this.#startY;
    const dx = x - this.#startX;
    if (!this.#pulling) {
      if (dy < -DEADZONE || Math.abs(dx) > Math.abs(dy)) {
        this.#active = false; // scrolling down the list or swiping sideways
        return 0;
      }
      if (dy < DEADZONE) return 0;
      this.#pulling = true;
    }
    this.distance = Math.min(MAX_PULL, Math.max(0, dy - DEADZONE) * DAMPING);
    return this.distance;
  }

  get pulling(): boolean {
    return this.#pulling;
  }

  /** Finish the gesture; true when it was pulled far enough to refresh. */
  end(): boolean {
    const fire = this.#pulling && this.distance >= PULL_THRESHOLD;
    this.#active = false;
    this.#pulling = false;
    this.distance = 0;
    return fire;
  }
}

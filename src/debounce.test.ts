import { describe, it, expect, vi } from "vitest";
import { debounce } from "./debounce";

// A controllable fake timer: set() records the callback + delay and returns an incrementing handle;
// flush() runs the most-recently-set (uncleared) callback. This lets the trailing-edge behavior be
// asserted deterministically without real time (the production default uses setTimeout/clearTimeout).
function fakeTimers() {
  let nextHandle = 1;
  const pending = new Map<number, { cb: () => void; ms: number }>();
  return {
    set: (cb: () => void, ms: number): number => {
      const h = nextHandle++;
      pending.set(h, { cb, ms });
      return h;
    },
    clear: (h: unknown): void => {
      pending.delete(h as number);
    },
    // Run every still-pending callback (a real timer would only fire the last after a burst, since each
    // earlier one was cleared on the next call; this mirrors that because cleared handles are deleted).
    flushAll: (): void => {
      for (const { cb } of pending.values()) cb();
      pending.clear();
    },
    pendingCount: (): number => pending.size,
    lastDelay: (): number | undefined => {
      let last: number | undefined;
      for (const { ms } of pending.values()) last = ms;
      return last;
    },
  };
}

describe("debounce", () => {
  it("runs fn only ONCE for a burst, after the last call settles (trailing edge)", () => {
    const t = fakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 200, t);

    d();
    d();
    d(); // a 3-call burst
    expect(fn).not.toHaveBeenCalled(); // nothing yet (still within the debounce window)
    expect(t.pendingCount()).toBe(1); // each call cleared the prior timer, so exactly one is pending

    t.flushAll();
    expect(fn).toHaveBeenCalledTimes(1); // the burst collapsed to a single trailing call
  });

  it("forwards the LAST call's arguments to fn", () => {
    const t = fakeTimers();
    const fn = vi.fn();
    const d = debounce<[number]>(fn, 100, t);

    d(1);
    d(2);
    d(3);
    t.flushAll();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3); // trailing edge keeps the most recent args
  });

  it("uses the configured delay", () => {
    const t = fakeTimers();
    const d = debounce(() => {}, 250, t);
    d();
    expect(t.lastDelay()).toBe(250);
  });

  it("cancel() drops a pending call so fn never runs (teardown safety)", () => {
    const t = fakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 200, t);

    d();
    expect(t.pendingCount()).toBe(1);
    d.cancel();
    expect(t.pendingCount()).toBe(0); // the queued timer was cleared
    t.flushAll();
    expect(fn).not.toHaveBeenCalled(); // exactly the post-exit "no late re-render" guarantee
  });

  it("a fresh call after cancel() schedules again", () => {
    const t = fakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 200, t);

    d();
    d.cancel();
    d(); // re-arm
    t.flushAll();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("the edit-mode reflow guard pattern: a queued re-render that fires after 'exit' is a no-op", () => {
    // Mirrors main.ts: the debounced handler re-renders only while editing; on exit the listener is
    // removed AND cancel() is called. Here we assert the editMode-guarded body does not act post-exit.
    const t = fakeTimers();
    let editMode = true;
    const renderVerovio = vi.fn();
    const reflow = debounce(() => {
      if (editMode) renderVerovio();
    }, 200, t);

    reflow(); // a resize arrived while editing
    editMode = false; // user exits before the debounce settles
    reflow.cancel(); // exitEditMode cancels the pending timer
    t.flushAll();
    expect(renderVerovio).not.toHaveBeenCalled();
  });
});

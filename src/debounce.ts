// A tiny trailing-edge debounce: the returned function defers `fn` until `delayMs` has elapsed since
// the LAST call, so a burst (e.g. a drag-resize firing `resize` every pixel) runs `fn` once, after the
// burst settles. `cancel()` drops any pending call (used to detach the edit-mode resize reflow on exit
// so a late timer cannot re-render after teardown). Timer-injectable so the trailing behavior is
// unit-testable without real time. No DOM, no globals.
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number,
  timers: {
    set: (cb: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  } = { set: (cb, ms) => setTimeout(cb, ms), clear: (h) => clearTimeout(h as never) },
): Debounced<A> {
  let handle: unknown;
  const debounced = ((...args: A): void => {
    if (handle !== undefined) timers.clear(handle);
    handle = timers.set(() => {
      handle = undefined;
      fn(...args);
    }, delayMs);
  }) as Debounced<A>;
  debounced.cancel = (): void => {
    if (handle !== undefined) {
      timers.clear(handle);
      handle = undefined;
    }
  };
  return debounced;
}

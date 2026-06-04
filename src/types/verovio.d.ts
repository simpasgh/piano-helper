// Ambient types for the `verovio` package (6.2.0). The npm package ships NO .d.ts and
// `@types/verovio` is not installed, so we declare the narrow toolkit surface P0 uses
// (render + sync + round-trip), mirroring the ESM build in node_modules/verovio/dist/verovio.mjs.
// Methods we do not call yet are intentionally omitted; add them when a later increment needs them.

declare module "verovio/wasm" {
  // The WASM glue object. We treat it as opaque: it is only ever passed to the
  // VerovioToolkit constructor. The binary is embedded in the .mjs, so no separate
  // .wasm fetch happens (good for Vite).
  export type VerovioModule = unknown;
  // Emscripten module factory. Resolves once the WASM runtime is initialized.
  const createVerovioModule: (moduleArg?: Record<string, unknown>) => Promise<VerovioModule>;
  export default createVerovioModule;
}

declare module "verovio/esm" {
  import type { VerovioModule } from "verovio/wasm";

  // One timemap entry: an onset in ms plus the element ids that start/stop there.
  // (Shape per the toolkit docs; only the fields P0 reads are typed.)
  export interface TimemapEntry {
    tstamp: number; // onset time in milliseconds
    qstamp?: number; // onset in quarter-note units
    on?: string[]; // ids of notes/chords starting at this tstamp
    off?: string[]; // ids ending at this tstamp
  }

  // Result of getElementsAtTime(ms): the cursor lookup. Chords are a distinct array
  // from notes so a click can target a chord vs a single note.
  export interface ElementsAtTime {
    notes: string[];
    chords?: string[];
    rests?: string[];
    page?: number;
    measure?: string;
  }

  export class VerovioToolkit {
    constructor(module: VerovioModule);
    destroy(): void;
    // Load MusicXML (auto-converted to MEI internally). Returns success.
    loadData(data: string): boolean;
    // Render one page (1-based) to an SVG string.
    renderToSVG(pageNo?: number, xmlDeclaration?: boolean): string;
    // Number of laid-out pages after a load.
    getPageCount(): number;
    // Full MEI export of the (possibly edited) model.
    getMEI(options?: Record<string, unknown>): string;
    // Build the MIDI representation; required before the timemap/time queries are valid.
    renderToMIDI(): string;
    // Per-onset timing skeleton; the equivalent of our stepTimes[].
    renderToTimemap(options?: Record<string, unknown>): TimemapEntry[];
    // Cursor lookup: which elements are sounding at a given ms.
    getElementsAtTime(millisec: number): ElementsAtTime;
    // Inverse: onset time in ms for an element id (-1 when unknown).
    getTimeForElement(xmlId: string): number;
    // MIDI values for a single note element id. Verovio 6.2.0 returns the note's values at the
    // top level: { pitch, duration, time } (verified against the installed package), so the MIDI
    // pitch number is `pitch`. Other keys may be present; we only read `pitch`.
    getMIDIValuesForElement(xmlId: string): { pitch?: number; duration?: number; time?: number };
    // Library version string.
    getVersion(): string;
    // Toolkit option setter (e.g. page dimensions, scale, layout).
    setOptions(options: Record<string, unknown>): void;
  }
}

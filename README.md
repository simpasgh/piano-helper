# Piano Helper

Turn piano sheet music into a falling-notes visual performance (Synthesia-style).

## Roadmap

The full vision is: **drop in a sheet-music PDF/image, watch it play** on an animated piano.
That pipeline is built in slices:

1. **Visualizer (current)** - load a MIDI file, hear it, and watch falling notes light up a piano keyboard.
2. **OMR** - convert sheet music (PDF/image) to MIDI, by wrapping an existing engine (e.g. [oemer](https://github.com/BreezeWhite/oemer) or the klang.io API).
3. **Correction UI** - review and fix recognition mistakes before playback.

## Tech

- [Vite](https://vitejs.dev/) + TypeScript
- [@tonejs/midi](https://github.com/Tonejs/Midi) for parsing
- [Tone.js](https://tonejs.github.io/) for synthesis and transport
- Canvas 2D for the keyboard and falling notes

## Develop

```bash
npm install
npm run dev
```

Open the printed localhost URL, click **Load MIDI**, pick a `.mid` file, then **Play**.
A demo file is included at `public/test-scale.mid` (a C major scale).

## Build

```bash
npm run build
npm run preview
```

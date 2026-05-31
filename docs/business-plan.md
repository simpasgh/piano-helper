# PlayMyScore: Business Plan

*Working name: PlayMyScore. Last updated 2026-05-31.*

> Drop in any piano sheet music (PDF or photo) and watch it play as a Synthesia-style
> falling-notes performance, with the printed sheet highlighted in sync. Bring any piece.
> No catalog, no account, free to start.

---

## 1. Executive summary

PlayMyScore turns a photo or PDF of piano sheet music into a falling-notes performance
(the "piano tutorial" look from YouTube) with the real sheet highlighted in time. The
product sits in a gap nobody else fills: learning apps have the falling-notes view but lock
you to their song catalog, and sheet-music scanners read your page but stop at notation or a
file export. PlayMyScore is the only seamless "bring your own sheet, watch it play, free"
flow.

- **Wedge:** arbitrary sheet music in, beginner-friendly falling notes out, free and
  no-account.
- **Primary user:** the adult self-taught beginner who has a specific piece they want to
  play and cannot find it in any catalog app.
- **Business model:** free product with a conversion cap, plus a one-time $39 Pro unlock.
  No subscription.
- **Honest constraint:** our automatic note-reading (OMR) is less accurate than Soundslice
  or PlayScore. We do not sell accuracy. We sell the experience, the freedom to bring any
  piece, and a price of zero to start.
- **The binding limit on the business is compute, not money:** each conversion is minutes of
  CPU on a single free worker, so the whole product can serve roughly 600 to 1,000
  conversions per month before we pay for infrastructure. Every pricing, growth, and product
  decision respects that ceiling.

---

## 2. Naming and domains

The product story is "drop in any sheet music, watch it play." The strongest names hint at
the input (sheet/score), the magic (it plays, it falls), or the speed. Almost every short
one-word music domain is already taken, so the realistic winners are coined or compound names
with an available domain.

Availability below was checked via DNS and whois on 2026-05-31. Registrar checkout is the
final word.

### Recommended name: PlayMyScore

`playmyscore.com` and `playmyscore.app` are both available. It is brandable, it doubles as a
keyword phrase ("play my sheet music"), and it reads as a clear promise. Marketing copy should
use the consumer term "sheet music" rather than "score," since beginners search for "sheet
music" and that is the SEO term that matters.

### Other available options (confirmed free .com plus .app)

| Name | Notes |
| --- | --- |
| **SheetFall** | Says exactly what the product does, strong SEO, beginner-friendly. |
| **Notecade** | Coined (note + cascade), the most brandable of the free set, room to grow beyond piano. |
| **FallKeys** | Short, punchy, ties falling notes to the keys. |
| **KeysFall** | Same idea, reversed. |

### Names to avoid

- **Notefall** and **Scrollo** were strong candidates but both have the `.com` and `.app`
  taken (a real branding tax).
- Short, trademark-crowded music words: **Aria, Cadenza, Cascade, Lumina**. The `.com` is
  gone and the trademark space is contested.
- **ScorePlay** is already a sports/media SaaS.

### Where to buy

Cloudflare Registrar (at-cost pricing, free WHOIS privacy, fits the existing stack),
Porkbun, or Namecheap. Avoid GoDaddy for the registration itself (higher renewals, upsells).
Grab the `.com` and `.app` together so nobody takes the matching pair, and enable auto-renew.

---

## 3. Market and competitors

Context: the online music-education market is roughly USD 4.6B in 2026 and growing about 15%
per year, with piano the largest segment. The category leader, Simply (JoyTunes), runs around
$200M ARR. This is a large, growing market with well-funded incumbents, so the opportunity is
a wedge they will not serve, not a head-on fight.

The decisive insight: across three competitor buckets, nobody combines our exact flow.

### Bucket 1: Falling-notes learning apps (same visual, different business)

They own the falling-notes experience but as content businesses. Their moat is a licensed
song catalog. You cannot bring an arbitrary scanned PDF.

| Competitor | Model and price | Strength | Weakness vs us |
| --- | --- | --- | --- |
| **Synthesia** | One-time ~$29 to $39 | Cheap, beloved, plays any MIDI | No sheet-music import (MIDI only), dated desktop UX |
| **Simply Piano** | ~$120/yr | Best-in-class onboarding, huge marketing | Closed curriculum, you play their songs, expensive |
| **Flowkey** | ~$120/yr | Real-recording tutorials, split-screen | Subscription, catalog-locked |
| **Skoove** | ~$120/yr | AI listening feedback | Catalog-locked, subscription |
| **La Touche Musicale** | ~6 to 10 EUR/mo, freemium | Generous free tier, also runs an audio-to-sheet tool | Falling notes still come from their catalog, not your scan |
| **Playground / Piano Marvel** | ~$108 to $150/yr | Song learning / teacher assessment | Course products; Piano Marvel allows uploads but buries it in a paid suite |

### Bucket 2: Scan-to-notation (OMR) tools (same input, different output)

They convert sheets but output notation or MIDI, not a beginner falling-notes performance.

| Competitor | Model and price | Strength | Weakness vs us |
| --- | --- | --- | --- |
| **PlayScore 2** | Freemium, ~$34.99 to $59.99/yr | Strong recognition, mobile-first | Output is notation playback and export, not falling notes; MusicXML paywalled |
| **Soundslice** | ~$50/yr, metered free scanning | Excellent OMR, slick web product, editing, sync | A "living sheet music" product for musicians and teachers, not a beginner falling-notes view; scanning is paid |
| **MuseScore 4** | Free, Pro ~$50 to $70/yr | Free, powerful, huge community library | Engraving software, steep for beginners, no falling-notes view |

### Bucket 3: Adjacent input (audio-to-sheet)

Tomplay (interactive catalog), and audio/YouTube-to-notation tools. A different, arguably
higher-demand input worth watching as an expansion lane (user-owned audio only).

### The empty cell (our wedge)

Cross the three buckets and one cell is empty: **bring your own arbitrary sheet music, watch
it play as a beginner-friendly falling-notes performance, free and uncapped-ish.**

- Learning apps have the view but lock you to their catalog.
- OMR tools take your sheet but end in notation or a file.
- Nobody offers the seamless scan to falling-notes flow, free, as one product.

Two honest caveats that shape everything:

1. **Our OMR is behind.** Soundslice and PlayScore are more accurate today. We compete on
   experience and price, never on transcription fidelity, and we present an honest "review and
   fix" step.
2. **The incumbents could build this, but they are disincentivized to.** A falling-notes-from-
   your-own-PDF feature cannibalizes their licensed catalogs. That is our durable structural
   advantage.

---

## 4. Product

### What it does today (shipped)

- Falling-notes visualizer (MIDI, then MusicXML input).
- Synced sheet view (printed score with a highlight cursor tracking the falling notes).
- OMR: convert a sheet PDF or image to MusicXML via the open-source oemer engine (async job:
  upload now, ready in a few minutes).
- Per-hand mute toggles for practice (mute one hand, watch it fall silently, hear the other).

### Known limitations (be honest in marketing)

The OMR engine reliably gets the right-hand melody, key, clefs, and many left-hand chords, but
it drops ties, rolled chords (arpeggios), dynamics, real tempo, and the title, and it makes
occasional octave or chord errors. These are engine-level gaps, not bugs in our code, and the
cheap fixes are exhausted. The correct answer is a human-in-the-loop correction step, not
chasing engine accuracy at high cost.

### Roadmap

Two truths shape the sequence. First, the OMR engine is near its ceiling on the things people
complain about, so the highest-leverage work is giving the user a fast way to fix the OMR, not
improving the OMR. Second, compute is the business ceiling, which makes a one-time unlock the
right model. Effort is rough (S/M/L). Tier notes which features are free vs Pro.

**Phase 1: MVP polish (make the core trustworthy)**

- **Correction UI v1** (S/M, free). Click a falling note bar, nudge its pitch up or down a
  semitone, delete a spurious note. Operates on the in-memory note data only; the edited bar
  may visibly diverge from the printed sheet in v1, which is honest. This is the linchpin: it
  converts an approximate scan into a score the user trusts, and it unblocks saving, exporting,
  and charging. Needs a short design spike first on what the user sees when an edit makes the
  falling view disagree with the synced sheet.
- **Confidence cues** (S/M, free, optional). Visually flag the notes most likely to be wrong
  so the eye goes straight to them. Only if derivable from existing structure, never by
  inventing notes.

**Phase 2: Growth (retention, funnel, ability to charge)**

- **Accounts + saved library** (M/L, free). Come back to a piece without re-scanning, which
  also saves a precious worker conversion. The substrate the paid tier sits on.
- **Conversion-cap meter** (M, ships with accounts). Enforce the free cap (3/day, 10/month)
  with a visible "X conversions left" meter. The load-bearing free-to-paid lever and the only
  thing that keeps demand under the worker ceiling.
- **Audio import v1** (M, free). Upload an MP3/WAV you own; in-browser pitch detection produces
  a single-line melody that feeds the existing pipeline. Runs on the user's device, so it costs
  zero hosting and does not consume the OMR worker ceiling. Monophonic only. No YouTube/URLs.
- **Export** (S to M, Pro). Download the corrected score as MIDI, MusicXML, or a falling-notes
  video. One of the two pillars that justify the unlock.
- **Pro unlock plumbing** (M). The one-time $39 purchase that raises the cap and unlocks
  export. Must land after correction UI, library, and export exist (so there is real value
  behind it) and before audio import becomes a growth channel.

**Phase 3: Evolution (push the deferred ceiling)**

- **Correction UI v2+** (L). Edit duration, add missing notes, write edits back to the printed
  sheet (the hard notation round-trip), persist to the library.
- **Stronger OMR engine / oemer + homr ensemble** (L, research-shaped). The one item genuinely
  gated by the engine, not our effort. Correctly comes last because the correction UI already
  gives users an escape hatch at near-zero risk.
- **Native tie / arpeggio / dynamics rendering** (M). Rides on the stronger engine; nothing to
  render until the engine emits the markup.

**If you only do three things next:** correction UI v1, then accounts + library + cap meter,
then the Pro unlock paired with export. Everything else is downstream of trust, retention, and
the ability to charge.

---

## 5. Monetization

The one fact that drives the model: the product is compute-throttled, not dollar-throttled.
Every conversion burns 3 to 6 minutes of CPU on a single free worker that processes jobs one
at a time. The question is not "how do we charge enough" but "how do we charge in a way that
never promises more compute than one free box can serve."

### Pricing

| Tier | Price | Conversion cap | Other |
| --- | --- | --- | --- |
| **Free** | $0 | 3 scans/day, 10/month | Full visualizer + synced sheet, unlimited free MusicXML/MIDI upload (zero compute), per-hand mute, all playback |
| **Pro** | **$39 one-time** | 30 scans/month (a number, never "unlimited") | Priority queue, multi-page PDF, video/MIDI/MusicXML export, future correction features |

Two deliberate choices:

- **MusicXML and MIDI uploads are free and unlimited** because they cost zero compute (parsed
  in the browser). Only the OMR scan path touches the worker, so that is the only thing capped.
- **The paid cap is a number, not "unlimited,"** because one free box physically cannot honor
  unlimited. 30/month covers any realistic hobbyist.

### Why a one-time unlock, not a subscription

For a solo founder on free infrastructure the one-time unlock wins on every axis: no churn to
manage, no implied service-level guarantee we cannot meet on one free worker, it matches the
proven Synthesia model, and the cash funds the only thing we would ever pay for (overflow
compute) in a lump rather than a recurring bill. Revisit a subscription only if conversion
volume forces paid compute AND retention data shows repeat weekly use.

Competitor reference: scanner tools price at $35 to $60/yr, the Synthesia-style player is a
one-time ~$29 to $39, learning apps are ~$120/yr. We sit deliberately below the learning-app
norm and do both jobs (scan and play).

### Revenue model (three scenarios, all assumptions stated)

Signup is implicit (no account wall at launch), so "activation" means a user ran at least one
scan. Price $39, net about $36 after payment fees. These are guesses, labeled as such, so any
cell can be swapped.

| Lever | Conservative | Base | Optimistic |
| --- | --- | --- | --- |
| Monthly unique visitors (steady state) | 1,000 | 5,000 | 20,000 |
| Activation (ran a scan) | 20% | 25% | 30% |
| Activated users/month | 200 | 1,250 | 6,000 |
| Buyer rate (of activated) | 1% | 2% | 3% |
| New buyers/month | 2 | 25 | 180 |
| **New revenue/month** | **~$72** | **~$900** | **~$6,480** |

Cumulative one-time revenue (assuming a 50% ramp over year one):

- **12 months:** ~$430 (conservative), ~$5,400 (base), ~$38,900 (optimistic).
- **24 months:** ~$1,300 (conservative), ~$16,200 (base), ~$116,600 (optimistic).

Read as orders of magnitude. Conservative is pocket money (fine for a zero-cost hobby), base
is real side income, optimistic is a small business but only if compute keeps up (see below).

### Kill metrics

1. **Conversions/day vs the worker ceiling.** When queue wait consistently exceeds ~10
   minutes, the free worker is saturated. That is the trigger to tighten the free cap or buy
   compute.
2. **Free-to-paid conversion on the unlock.** Below ~1% you have a cost center, not a business.
   At ~2% it is a healthy side income; at ~3% it funds its own paid compute with margin.

---

## 6. Cost and infrastructure scaling

The binding constraint is throughput and queue wait, not dollars. The host is free, so you
never get a surprise bill, you get a slow queue.

- **Per scan:** roughly 4 to 5 minutes of CPU (a guess, narrowed from ~6.5 min at higher DPI).
- **Throughput:** about 12 to 15 scans/hour on one serial worker, realistically ~100 to 200
  scans/day before the queue turns hostile, and less because the interim Mac host is not 24/7.
- **Design ceiling:** about 600 to 1,000 conversions/month before any free tier breaks. Plan
  pricing and capacity around this number.

### Staged scaling path (stay free as long as possible)

| Stage | What | Monthly cost | Volume served |
| --- | --- | --- | --- |
| 0 (today) | Mac via launchd, serial, not 24/7 | $0 | Unreliable |
| 1 | Oracle Always Free ARM, true 24/7, plus an R2 job queue | $0 | ~100 to 200+ scans/day |
| 2 | Add a free parallel worker (second Oracle region or Cloud Run overflow) | $0 | 2 to 3x stage 1 |
| 3 (first paid step) | One small dedicated VM, e.g. Hetzner CX22 (~EUR 4/mo) | ~EUR 4 to 5 | Low thousands/month |
| 4 | Scale paid horizontally, more small boxes behind the queue | ~EUR 4 to 5 each | Linear |

The biggest single win is free: move off the Mac onto the Oracle Always Free box with a real
queue. Do not pay until free parallelism is exhausted.

### Trigger to act

Median queue wait above ~5 minutes sustained, or sustained traffic above ~150 scans/day, or
monthly conversions approaching ~600 to 800. The cheapest correct response at that moment is to
add a free parallel worker, not to pay. The worker is host-agnostic, so each move is config,
not a rewrite.

### Does the unlock fund the compute?

Overwhelmingly. A single $39 sale (about $37.84 net) funds 7 to 9 months of the first paid VM.
A single Pro buyer's lifetime of conversions costs cents of compute. The cost cliff is real for
user experience (queue wait degrades before it costs money) but trivial for the profit and
loss. Obsess over the Pro conversion rate, not the server bill.

---

## 7. Go-to-market (90-day plan)

Audience anchor for every word: the adult self-taught beginner who has a PDF or photo of a
piece they actually want to play and is intimidated by notation. We sell the experience and
the freedom to bring any piece, never "perfect transcription," and we surface the "review and
fix" step as a normal part of the flow.

### Positioning

- **Hook:** "Drop in any sheet music and watch it play. Free."
- **Category framing:** "Synthesia, but it reads YOUR sheet music. No catalog, no lock-in,
  free."
- **Proof points:** (1) bring your own piece, not a fixed catalog; (2) see it fall and hear it,
  with the real sheet in sync; (3) free to start, no account, no card.
- **Honesty as a feature:** "Auto-reading sheet music is not perfect yet. We show you the notes
  so you can spot and fix any slips before you play." This pre-empts the top launch complaint.

### Channels (ranked for a solo founder)

1. **SEO (the compounding channel).** The exact-match query space is underserved. Target
   phrases: "sheet music to synthesia," "convert sheet music to falling notes," "play my sheet
   music online free," "scan sheet music and hear it play," "synthesia alternative free no
   download," "turn sheet music into a piano tutorial," plus informational queries like "how to
   read piano sheet music as a beginner" that funnel into the tool. Slow to rank (3 to 6
   months), so start in week one.
2. **Reddit and niche communities.** r/piano, r/pianolearning, adult-beginner Facebook groups,
   piano Discords. Lead with a demo clip, not a link. Reply to every comment for the first 24
   to 48 hours. One post per community, spaced out, honoring each community's self-promotion
   rules. State the accuracy limitation up front; on these channels honesty earns goodwill.
3. **The shareable demo loop.** The share unit is a pre-rendered, watch-only clip of a
   recognizable piece, not a live conversion. A viewer watching a clip costs us nothing, so the
   output is infinitely shareable while the input stays gated. Add an in-app "share your result"
   that produces a watch-only replay that does not re-run OMR. This decouples virality from the
   worker ceiling.

### Timeline

- **Weeks 1 to 4 (pre-launch):** grab the domain and handles; ship the landing page with the
  upload-and-watch flow and the visible review step; stand up the SEO product page; set up
  analytics for the activation funnel; produce 8 to 12 seed clips of recognizable pieces (favor
  public domain); write two informational SEO posts; start being genuinely present in the
  communities; build a launch-day list of 200 to 400 allies; run a small beta and collect
  testimonials.
- **Week 5 (launch):** stagger the posts. Soft launch to the list and indie communities
  (Monday), Product Hunt (Tuesday or Wednesday, 00:01 PT, founder comment within the first
  minute), Show HN (mid-week, lead with the engineering story), then the big Reddit posts to
  r/piano and r/pianolearning (spaced a day apart, save real energy for these). Throttle to the
  watch-only clips if conversions approach the ceiling.
- **Weeks 6 to 13 (growth):** one new shareable clip per week, one SEO article every week or
  two, light consistent community presence. Iterate the funnel on real data (fix the biggest
  drop), A/B the hero hook, and introduce the Pro unlock only once activation is healthy
  (around weeks 9 to 13), positioned as "support the project plus unlock more conversions."

### Metrics

- **Activation rate** (upload-started, conversion-completed, playback-started), target above
  25% of uploaders reaching playback. The single most important number.
- **Share rate** (used "share your result" or arrived from a shared clip). The organic-growth
  flywheel.
- **Top activating source** (not top by raw volume). Expect r/pianolearning and SEO to
  out-activate a big shallow spike.

### Realistic expectation

A featured Product Hunt launch might bring 1,000 to 5,000 visitors and tens to ~150 signups.
Show HN and Reddit add spiky, well-fit traffic. Plan for a launch-week total of a few thousand
visitors and a first cohort of dozens to low hundreds of activated users. The durable growth
comes from the two slow compounders started on day one: the SEO keyword cluster and the
shareable-clip loop. Do not switch on the paywall until people demonstrably love the free
product.

---

## 8. Legal limitations

General guidance, not legal advice. Get a one-hour attorney review of the terms and privacy
templates before a real launch, and a consult before responding to any real takedown.

### Copyright of user uploads

The posture is good, and the architecture is the reason. We host no catalog, OMR is a
transformation tool (legally like a scanner or a format converter), and the pipeline is
transient by design (uploads are deleted after conversion). The infringement question, if any,
attaches to what the user does, not to the tool.

- **DMCA safe harbor** matters once a saved-library feature stores user content. To be
  eligible, register a DMCA designated agent with the US Copyright Office (a $6 one-time
  filing) before shipping any storage, and add a notice-and-takedown flow plus a repeat-
  infringer policy.
- **Do not build a shared or public library of user-uploaded scores.** That single move turns
  you from a passthrough tool into a distributor of copyrighted works, which is exactly what
  rightsholders sue over. Keep every upload private to its uploader.

### Terms of service (must-haves)

The user is solely responsible for what they upload and warrants they have the right to use
it; OMR output is provided as-is with no accuracy warranty; no redistribution of others'
copyrighted output; prohibited uses (no content you lack rights to, no building a shared
library, no queue abuse); a liability cap and indemnity; and a link to the DMCA procedure.

### Privacy and data

If uploads are processed then deleted (current architecture), compliance is nearly trivial:
just a short privacy notice explaining transient processing, no data sale, and what minimal
logs you keep. A saved-library feature flips on real duties (a privacy policy, a retention
window, access/export/delete rights, a breach posture). Keep transient-only as long as the
product allows; gate the library behind a conscious decision plus the DMCA-agent and privacy
work above.

### Audio import

A higher-risk lane. Ship user-owned audio file upload only, with copy that frames it as "audio
you own," the same transient processing, and the same responsibility clause. Never add
URL/YouTube/streaming ingestion (terms-of-service breach and technically off-table on the
runtime).

### Do / avoid checklist

**Do:** keep convert-then-discard as the default; ship a short ToS and privacy notice before
any growth push; register a DMCA agent before any storage feature; keep every upload private;
accept user-owned audio files only; get an attorney review of templates.

**Avoid:** a shared or searchable library of user-uploaded copyrighted scores; storing uploads
indefinitely without a retention policy; any URL/YouTube/streaming audio ingestion; implying
you vet uploads for copyright; marketing the tool as a way to copy or share copyrighted music.

---

## 9. Risks

1. **OMR fidelity gap.** Our biggest weakness. Beginners cannot spot wrong notes, so a wrong
   note teaches a wrong note. Mitigate with honest copy, a strong correction UI, and starting
   with clean digital PDFs where the engine does best.
2. **Compute cost vs the free constraint.** OMR is heavy and the free box caps throughput. A
   viral spike or an "unlimited" promise could break the model. Mitigate with a queue, hard
   free caps, and never promising unlimited.
3. **Soundslice (or an incumbent) adds the feature.** Soundslice has the best OMR and the
   product surface, so a falling-notes mode is plausible. But the probability is low (roughly 20
   to 30% in 12 to 18 months): their audience is notation-literate musicians and teachers, their
   founder is customer-led and anti-gamification, and a beginner falling-notes mode has no clear
   ROI for their teacher and embed revenue. The real risk is incidental, not strategic (the
   feature is about one engineer-month for them), so never let the feature be our moat. Our
   defensible position is the combination they will not adopt: free, no-account, non-reader,
   falling-notes-first. Early-warning signals to watch: a piano-roll toggle ships, scanning
   becomes free or expanded, beginner / "learn without reading music" messaging appears, or a
   free consumer mobile app.
4. **Retention.** A one-shot "watch it play" novelty may not retain. Mitigate with the saved
   library, practice features, and audio import to keep giving reasons to return.
5. **Licensing perception.** We do not host content, which is the right posture, but be clear in
   the terms that users are responsible for their uploads, and never build a catalog of
   copyrighted sheets.

---

## 10. Bottom line

The wedge is genuine and structurally defensible: the incumbents are disincentivized to let you
play your own sheet, because it cannibalizes their catalogs. Win on experience and "free plus
your own sheet," not on transcription accuracy, where we currently lose. Keep the build on free
tooling, monetize convenience lightly with a one-time unlock, and guard the two risks that
matter most above all others: OMR trust and OMR compute cost.

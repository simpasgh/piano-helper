import "./admin.css";
import {
  FLAG_METADATA,
  emptyState,
  withFlag,
  stateFromConfig,
  configFromState,
  type FlagState,
  type FlagMeta,
  type FlagSection,
} from "./admin-flags";
import type { FlagKey } from "./flags-server";

// Admin page for the OMR feature flags. Reads + writes the R2 config object via the token-gated
// /api/flags endpoint; the always-on worker applies it onto os.environ each ~5s poll, so a toggle
// takes effect with no restart. The token lives in localStorage (best-effort, like main.ts).

const TOKEN_KEY = "pianoHelper.adminToken";

function loadToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}
function persistToken(value: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, value);
  } catch {
    // best effort; the token still works for this session.
  }
}

let token = loadToken();
let state: FlagState = emptyState();
let dirty = false;

const root = document.getElementById("admin-root") as HTMLElement;
// Per-flag DOM refs so a toggle can sync the whole list in place (cascades can flip OTHER flags)
// without re-rendering and losing focus.
const cardRefs = new Map<FlagKey, { card: HTMLElement; input: HTMLInputElement }>();
let saveBtn: HTMLButtonElement | null = null;
let statusEl: HTMLElement | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function errorMessage(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

async function fetchFlags(): Promise<void> {
  const res = await fetch("/api/flags", { headers: authHeaders() });
  if (!res.ok) throw new Error(await errorMessage(res));
  const data = (await res.json()) as { flags?: Partial<Record<FlagKey, "0" | "1">> };
  state = stateFromConfig(data.flags ?? {});
  dirty = false;
}

// Save the current state and return the exact config that was sent. Does NOT overwrite `state` from
// the server echo, so a toggle made DURING the save (the cards stay interactive) is preserved; the
// caller recomputes `dirty` by comparing the live state to what was sent.
async function saveFlags(): Promise<Record<FlagKey, "0" | "1">> {
  const sending = configFromState(state);
  const res = await fetch("/api/flags", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(sending),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  await res.json().catch(() => ({})); // drain the body; the echo equals `sending`.
  return sending;
}

// ---- Rendering ---------------------------------------------------------------------------------

function setStatus(text: string, kind: "" | "ok" | "error" = ""): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = `save-status${kind ? " " + kind : ""}`;
}

// Reflect the current `state` onto every card's checkbox + on-styling, and the Save button's enabled
// state. Called after a toggle so dependency cascades (which can flip other flags) show immediately.
function syncCards(): void {
  for (const meta of FLAG_METADATA) {
    const ref = cardRefs.get(meta.key);
    if (!ref) continue;
    const on = state[meta.key];
    ref.input.checked = on;
    ref.card.classList.toggle("is-on", on);
  }
  if (saveBtn) saveBtn.disabled = !dirty;
}

function flagCard(meta: FlagMeta): HTMLElement {
  const input = el("input", {
    type: "checkbox",
    "aria-label": `${meta.label} (${meta.key})`,
  }) as HTMLInputElement;
  input.checked = state[meta.key];
  input.addEventListener("change", () => {
    state = withFlag(state, meta.key, input.checked);
    dirty = true;
    syncCards();
    setStatus("Unsaved changes.");
  });

  const title = el("div", { class: "flag-title" }, [
    el("span", { class: "flag-label" }, [meta.label]),
    el("span", { class: "flag-key" }, [meta.key]),
    el("span", { class: "badge badge-tier" }, [`Tier ${meta.tier}`]),
  ]);
  if (meta.recommended) {
    title.append(el("span", { class: "badge badge-rec" }, ["Recommended"]));
  }

  const head = el("div", { class: "flag-head" }, [
    title,
    el("label", { class: "switch" }, [
      input,
      el("span", { class: "track", "aria-hidden": "true" }),
      el("span", { class: "thumb", "aria-hidden": "true" }),
    ]),
  ]);

  const impacts = el("div", { class: "impacts" }, [
    el("span", { class: "impact-label" }, ["Accuracy"]),
    el("span", { class: "impact-value" }, [meta.accuracy]),
    el("span", { class: "impact-label" }, ["Latency"]),
    el("span", { class: "impact-value" }, [meta.latency]),
    el("span", { class: "impact-label" }, ["Algorithm"]),
    el("span", { class: "impact-value" }, [meta.algorithm]),
  ]);

  const card = el("div", { class: "flag-card" + (meta.recommended ? " recommended" : "") }, [
    head,
    el("p", { class: "flag-summary" }, [meta.summary]),
    impacts,
  ]);
  if (meta.requires.length > 0) {
    card.append(
      el("p", { class: "dep-note" }, [`Needs: ${meta.requires.join(", ")} (enabled automatically)`]),
    );
  }
  card.classList.toggle("is-on", state[meta.key]);
  cardRefs.set(meta.key, { card, input });
  return card;
}

function sectionTitle(section: FlagSection): string {
  return section === "engine"
    ? "Recognition engine (accuracy)"
    : "Delivery (speed to first notes)";
}

function renderConnected(): void {
  cardRefs.clear();
  root.replaceChildren();

  root.append(
    el("h1", {}, ["OMR feature flags"]),
    el("p", { class: "admin-sub" }, [
      "Toggle the recognition + delivery engines live. Changes apply to the worker within a few " +
        "seconds, no restart. Ordered primitive to advanced; each flag lists its accuracy, latency, " +
        "and algorithm.",
    ]),
    el("div", { class: "suggest" }, [
      "Suggested: turn on ",
      el("strong", {}, ["Geom pitch + Clarity rhythm (fusion)"]),
      " for the best accuracy and ",
      el("strong", {}, ["Progressive fast-then-refine"]),
      " so all the notes show in about 5 seconds while the rhythm refines.",
    ]),
  );

  for (const section of ["engine", "delivery"] as FlagSection[]) {
    root.append(el("h2", { class: "section-title" }, [sectionTitle(section)]));
    for (const meta of FLAG_METADATA.filter((m) => m.section === section)) {
      root.append(flagCard(meta));
    }
  }

  saveBtn = el("button", { class: "btn btn-primary", type: "button" }, ["Save"]) as HTMLButtonElement;
  saveBtn.disabled = !dirty;
  saveBtn.addEventListener("click", () => void onSave());
  const changeToken = el("button", { class: "btn", type: "button" }, ["Sign out"]);
  changeToken.addEventListener("click", () => {
    // Sign out: clear the stored token so a reload does not silently auto-connect (matters on a
    // shared machine), and return to an empty gate.
    token = "";
    persistToken("");
    renderTokenGate();
  });
  statusEl = el("span", { class: "save-status" }, [dirty ? "Unsaved changes." : "Up to date."]);

  root.append(el("div", { class: "save-bar" }, [changeToken, saveBtn, statusEl]));
}

async function onSave(): Promise<void> {
  if (!saveBtn) return;
  saveBtn.disabled = true;
  setStatus("Saving...");
  try {
    const sent = await saveFlags();
    // Preserve a toggle made DURING the save: dirty reflects whether the live state still differs
    // from what was sent (configFromState emits keys in KNOWN_FLAGS order, so stringify can compare).
    dirty = JSON.stringify(configFromState(state)) !== JSON.stringify(sent);
    syncCards();
    setStatus(
      dirty
        ? "Saved, but you have newer unsaved changes."
        : "Saved. The worker will pick it up within a few seconds.",
      "ok",
    );
  } catch (err) {
    setStatus((err as Error).message, "error");
  } finally {
    if (saveBtn) saveBtn.disabled = !dirty;
  }
}

function renderTokenGate(errorText = ""): void {
  cardRefs.clear();
  saveBtn = null;
  statusEl = null;
  root.replaceChildren();

  const input = el("input", {
    type: "password",
    placeholder: "Admin token",
    "aria-label": "Admin token",
  }) as HTMLInputElement;
  input.value = token;

  const connect = el("button", { class: "btn btn-primary", type: "button" }, ["Connect"]);
  const status = el("span", { class: `save-status${errorText ? " error" : ""}` }, [errorText]);

  const submit = async (): Promise<void> => {
    token = input.value.trim();
    persistToken(token);
    status.className = "save-status";
    status.textContent = "Connecting...";
    connect.setAttribute("disabled", "true");
    try {
      await fetchFlags();
      renderConnected();
    } catch (err) {
      renderTokenGate((err as Error).message);
    }
  };
  connect.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });

  root.append(
    el("h1", {}, ["OMR feature flags"]),
    el("p", { class: "admin-sub" }, [
      "Enter the admin token to view and change the recognition + delivery engines. The token is set " +
        "as a secret on the deployment; this page does nothing without it.",
    ]),
    el("div", { class: "token-bar" }, [el("label", {}, ["Admin token"]), input, connect]),
    status,
  );
  input.focus();
}

// Boot: if a token is already stored, try to connect straight away; else show the gate.
if (token) {
  fetchFlags()
    .then(renderConnected)
    .catch((err: Error) => renderTokenGate(err.message));
} else {
  renderTokenGate();
}

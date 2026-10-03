"use strict";

const BACKEND_URL = "https://mo-backend-fzbn.onrender.com"; // set after deploying — see README

// --- Sign-in config (Chrome, Brave, and any other Chromium browser) ---
// Uses chrome.identity.launchWebAuthFlow (a plain OAuth popup) rather than
// getAuthToken, which only works in real Chrome with a native Google account.
// Needs an OAuth client of type "Web application" whose Authorized redirect
// URI is https://kbmcmpbbinpjpcimnoggdmelffgjobij.chromiumapp.org/ (that's
// chrome.identity.getRedirectURL() for this extension's pinned ID). Safari is
// not supported — see README.
const WEB_CLIENT_ID = "269390370504-gmdl1a28ghlcg385r93cd8caallg4m7f.apps.googleusercontent.com";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
];
const WORKSPACE_DOMAIN = "dlsu.edu.ph"; // keep in sync with ALLOWED_EMAIL_DOMAIN on the server
const TOKEN_CACHE_KEY = "moAuthTokenCache"; // chrome.storage.local: { accessToken, expiresAt }

// Saved per-document popup state (selections + last result), so closing the
// popup doesn't throw the review away. Local to this browser only.
const STATE_PREFIX = "moPopupState:";
const STATE_INDEX_KEY = "moPopupIndex";
const MAX_SAVED_DOCS = 12;

const REQUEST_TIMEOUT_MS = 120 * 1000; // a cold-starting Render server can take ~1 minute

// Mirrors DISMISSIBLE_ISSUE_CODES in server/src/googleDocs.js — these are
// exactly the "please check manually" issue types across the rule engine,
// never a hard pass/fail one, so a reviewer can permanently mute one for
// this document once they've confirmed it by eye.
const DISMISSIBLE_ISSUE_TYPES = new Set([
  "signatory_block_page_break_needs_manual_check",
  "witness_whereof_page_break_needs_manual_check",
  "top_right_code_needs_manual_check",
  "signatory_block_page_fit_unknown",
  "gtc_section_not_found",
  "event_date_format_unclear",
  "constant_signatory_position_needs_manual_check",
]);

const PARTY_HINTS = {
  "cso-org": 'CSO EVCE under "By:" and Director for SLIFE under "Witnessed by:".',
  "org-org": 'Both CSO EVCE and Director for SLIFE under "Witnessed by:".',
  "cso-noncso":
    "CSO ORG/MAIN and a non-CSO-recognized org. Whether the standard format applies depends on who's inviting whom — answer below.",
};
const INVITING_HINTS = {
  yes: "CSO initiated this — the standard MOA format applies, so Mo runs the full checklist (same as CSO MAIN - CSO ORG).",
  no: 'CSO was invited — the standard format doesn\'t apply. Mo only checks that Director for SLIFE and CSO EVCE both appear under "Witnessed by:"; every other check is skipped.',
};

// ---------- State ----------

let selectedType = null;
let selectedCoding = null; // "coded" | "non_coded" — Sponsorship only, per moa.md
let selectedCsoParty = null; // "cso-org" | "org-org" | "cso-noncso" — Internal only
let selectedCsoInviting = null; // "yes" | "no" — only meaningful when selectedCsoParty === "cso-noncso"

let currentDoc = undefined; // undefined = still looking, null = no document open, object = found
let lastResult = null;
let lastCheckedAt = null;
let lastCheckedDocId = null; // the file marks/overrides live on — differs from currentDoc.id for Word files
let lastResultKey = null;
let activeCheck = null; // AbortController of the in-flight check

// ---------- DOM ----------

const $ = (id) => document.getElementById(id);
const checkBtn = $("checkBtn");
const statusEl = $("status");
const docCard = $("docCard");
const docGlyph = $("docGlyph");
const docTitle = $("docTitle");
const docKind = $("docKind");
const docNote = $("docNote");
const codingSection = $("codingSection");
const csoPartySection = $("csoPartySection");
const csoInvitingSection = $("csoInvitingSection");
const csoPartyHint = $("csoPartyHint");
const csoInvitingHint = $("csoInvitingHint");
const archiveToggleBtn = $("archiveToggleBtn");
const archivePanel = $("archivePanel");
const archiveList = $("archiveList");

const ICONS = {
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10.3 3.9a2 2 0 0 1 3.4 0l8.1 14a2 2 0 0 1-1.7 3H3.9a2 2 0 0 1-1.7-3z"/><path d="M12 9.5v4.2" fill="none" stroke-width="2.2" stroke-linecap="round" style="stroke:var(--surface)"/><circle cx="12" cy="17" r="1.25" style="fill:var(--surface)"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 7v5.2l3.4 2"/></svg>',
  spinner:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity=".2"/><path d="M12 3a9 9 0 0 1 9 9"/></svg>',
};

// Tiny DOM builder. Everything user- or server-supplied goes in as text nodes,
// never as HTML, and nothing is smuggled through attributes.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v; // static, trusted SVG strings only
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------- Segmented controls / choice lists ----------

function initChoice(root, onChange) {
  const options = [...root.querySelectorAll('[role="radio"]')];
  const isSeg = root.classList.contains("seg");
  if (isSeg) root.style.setProperty("--n", options.length);
  let value = null;

  function paint(instant) {
    options.forEach((o) => {
      const on = o.dataset.value === value;
      o.setAttribute("aria-checked", String(on));
      o.tabIndex = on || (value === null && o === options[0]) ? 0 : -1;
    });
    if (!isSeg) return;
    const idx = options.findIndex((o) => o.dataset.value === value);
    root.classList.toggle("has-value", idx >= 0);
    if (idx < 0) return;
    if (instant) root.classList.add("no-anim");
    root.style.setProperty("--i", idx);
    if (instant) {
      void root.offsetWidth; // commit the position before re-enabling the transition
      root.classList.remove("no-anim");
    }
  }

  function select(next, { silent = false, instant = false } = {}) {
    value = next;
    paint(instant);
    if (!silent) onChange?.(value);
  }

  options.forEach((o, i) => {
    o.addEventListener("click", () => select(o.dataset.value));
    o.addEventListener("keydown", (e) => {
      const forward = ["ArrowRight", "ArrowDown"];
      const back = ["ArrowLeft", "ArrowUp"];
      if (![...forward, ...back].includes(e.key)) return;
      e.preventDefault();
      const next = options[(i + (forward.includes(e.key) ? 1 : options.length - 1)) % options.length];
      next.focus();
      select(next.dataset.value);
    });
  });
  paint(true);

  return {
    set: (v, opts) => select(v, opts),
    clear() {
      value = null;
      paint(true);
    },
  };
}

function setOpen(el, open) {
  el.classList.toggle("open", open);
  el.inert = !open;
}

const typeCtl = initChoice($("typeSeg"), (v) => {
  selectedType = v;

  // The coded/non-coded precaution toggle only applies to Sponsorship.
  if (selectedType !== "sponsorship") {
    selectedCoding = null;
    codingCtl.clear();
  }
  // The CSO-party toggle (and its follow-up) only applies to Internal.
  if (selectedType !== "internal") {
    selectedCsoParty = null;
    partyCtl.clear();
    selectedCsoInviting = null;
    invitingCtl.clear();
  }
  syncVisibility();
  updateCheckBtn();
  persist();
});

const codingCtl = initChoice($("codingSeg"), (v) => {
  selectedCoding = v;
  updateCheckBtn();
  persist();
});

const partyCtl = initChoice($("csoPartyList"), (v) => {
  selectedCsoParty = v;
  // The inviting Yes/No toggle only applies to CSO ORG/MAIN - NON CSO ORG.
  if (selectedCsoParty !== "cso-noncso") {
    selectedCsoInviting = null;
    invitingCtl.clear();
  }
  syncVisibility();
  updateCheckBtn();
  persist();
});

const invitingCtl = initChoice($("csoInvitingSeg"), (v) => {
  selectedCsoInviting = v;
  syncVisibility();
  updateCheckBtn();
  persist();
});

function syncVisibility() {
  setOpen(codingSection, selectedType === "sponsorship");
  setOpen(csoPartySection, selectedType === "internal");
  setOpen(csoInvitingSection, selectedType === "internal" && selectedCsoParty === "cso-noncso");
  csoPartyHint.textContent = PARTY_HINTS[selectedCsoParty] || "";
  csoInvitingHint.textContent = INVITING_HINTS[selectedCsoInviting] || "";
}

// Single source of truth for turning the Internal sub-selections into the
// two flags the backend actually cares about — used by both the /check
// and /archive request bodies so they can never drift out of sync with
// each other.
//   cso-org      -> csoIsParty=true,  witnessedByOnlyMode=false (CSO MAIN - CSO ORG)
//   org-org      -> csoIsParty=false, witnessedByOnlyMode=false (CSO ORG - CSO ORG)
//   cso-noncso + inviting=yes -> csoIsParty=true,  witnessedByOnlyMode=false (standard format applies)
//   cso-noncso + inviting=no  -> csoIsParty=false, witnessedByOnlyMode=true  ("Witnessed by:" only, everything else skipped)
function getInternalFlags() {
  if (selectedType !== "internal") {
    return { csoIsParty: undefined, witnessedByOnlyMode: undefined };
  }
  if (selectedCsoParty === "cso-noncso") {
    if (selectedCsoInviting === "no") return { csoIsParty: false, witnessedByOnlyMode: true };
    if (selectedCsoInviting === "yes") return { csoIsParty: true, witnessedByOnlyMode: false };
    return { csoIsParty: undefined, witnessedByOnlyMode: undefined }; // not yet answered
  }
  return { csoIsParty: selectedCsoParty === "cso-org", witnessedByOnlyMode: false };
}

function selectionKey() {
  return [selectedType, selectedCoding, selectedCsoParty, selectedCsoInviting].join("|");
}

function updateCheckBtn() {
  if (currentDoc === null) {
    checkBtn.disabled = true;
    checkBtn.textContent = "Open a Google Doc to begin";
    return;
  }

  const needsCoding = selectedType === "sponsorship";
  const needsCsoParty = selectedType === "internal";
  const needsCsoInviting = selectedType === "internal" && selectedCsoParty === "cso-noncso";
  const ready =
    currentDoc &&
    selectedType &&
    (!needsCoding || selectedCoding) &&
    (!needsCsoParty || selectedCsoParty) &&
    (!needsCsoInviting || selectedCsoInviting);

  checkBtn.disabled = !ready;
  if (!selectedType) {
    checkBtn.textContent = "Select a type to begin";
  } else if (needsCoding && !selectedCoding) {
    checkBtn.textContent = "Select coded or non-coded";
  } else if (needsCsoParty && !selectedCsoParty) {
    checkBtn.textContent = "Which Internal MOA type?";
  } else if (needsCsoInviting && !selectedCsoInviting) {
    checkBtn.textContent = "Is CSO ORG/MAIN inviting?";
  } else if (lastResult && lastResultKey === selectionKey()) {
    checkBtn.textContent = "Check again";
  } else if (needsCsoInviting && selectedCsoInviting === "no") {
    checkBtn.textContent = "Check (Witnessed by: only)";
  } else {
    const typeLabel = $("typeSeg").querySelector(`[data-value="${selectedType}"]`)?.textContent;
    checkBtn.textContent = `Check as ${typeLabel}`;
  }
}

// ---------- Document detection ----------

function parseTab(url, rawTitle) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== "docs.google.com" && u.hostname !== "drive.google.com") return null;

  const match =
    u.pathname.match(/\/(?:document|file)\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/) ||
    (u.hostname === "drive.google.com" && u.pathname === "/open" ? u.search.match(/[?&]id=([a-zA-Z0-9_-]+)/) : null);
  if (!match) return null;

  const title = (rawTitle || "").replace(/\s[-–—]\s(Google Docs|Google Drive)\s*$/i, "").trim();
  const ext = (title.match(/\.(docx?|pdf)$/i)?.[1] || "").toLowerCase();
  const isWord = ext === "docx" || ext === "doc";
  const isPdf = ext === "pdf";

  return {
    id: match[1],
    title,
    isWord,
    kindLabel: isWord ? "Word file" : isPdf ? "PDF" : u.hostname === "docs.google.com" ? "Google Doc" : "File in Drive",
    note: isWord
      ? "Word files are checked on a converted Google Docs copy. Your original isn't changed."
      : isPdf
      ? "PDFs are checked read-only — nothing is written back into the file."
      : "",
  };
}

async function detectDocument() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return parseTab(tab?.url || "", tab?.title || "");
}

function renderDocCard() {
  docGlyph.innerHTML = ICONS.doc;
  docCard.classList.toggle("none", !currentDoc);
  if (!currentDoc) {
    docTitle.textContent = "No document open";
    docKind.textContent = "Open a Google Doc, Word file or PDF to begin.";
    docNote.textContent = "";
    return;
  }
  docTitle.textContent = currentDoc.title || "Untitled document";
  docKind.textContent = currentDoc.kindLabel;
  docNote.textContent = currentDoc.note;
}

// Render's free tier sleeps when idle; a throwaway request while the reviewer
// is still picking a type means the real check doesn't pay the cold start.
function wakeServer() {
  fetch(`${BACKEND_URL}/health`, { cache: "no-store" }).catch(() => {});
}

// ---------- Auth ----------

// Reads a still-valid cached token from chrome.storage.local, or null.
// launchWebAuthFlow doesn't cache tokens the way getAuthToken did, so we do it
// ourselves — otherwise every Check click would pop open a Google sign-in window.
async function getCachedToken() {
  const { [TOKEN_CACHE_KEY]: cached } = await chrome.storage.local.get(TOKEN_CACHE_KEY);
  if (!cached || !cached.accessToken || !cached.expiresAt) return null;
  const SAFETY_MARGIN_MS = 60 * 1000; // treat tokens as expired 1 min early
  if (Date.now() > cached.expiresAt - SAFETY_MARGIN_MS) return null;
  return cached.accessToken;
}

async function cacheToken(accessToken, expiresInSeconds) {
  await chrome.storage.local.set({
    [TOKEN_CACHE_KEY]: { accessToken, expiresAt: Date.now() + Number(expiresInSeconds || 3600) * 1000 },
  });
}

async function clearCachedToken() {
  await chrome.storage.local.remove(TOKEN_CACHE_KEY);
}

function launchFlow(url, interactive) {
  return new Promise((resolve) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (responseUrl) => {
      resolve({ responseUrl, error: chrome.runtime.lastError?.message });
    });
  });
}

async function getAuthToken() {
  const cached = await getCachedToken();
  if (cached) return cached;

  const redirectUri = chrome.identity.getRedirectURL();
  const buildAuthUrl = (prompt) =>
    `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${encodeURIComponent(WEB_CLIENT_ID)}` +
    `&response_type=token` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(OAUTH_SCOPES.join(" "))}` +
    // hd = Workspace domain hint: the account chooser only offers @dlsu.edu.ph
    // accounts. A hint only — the server still enforces the real allowlist.
    `&hd=${encodeURIComponent(WORKSPACE_DOMAIN)}` +
    `&prompt=${prompt}`;

  const parseTokenResponse = (responseUrl) => {
    // Token comes back in the URL fragment: #access_token=...&expires_in=3599&...
    const fragment = new URLSearchParams(new URL(responseUrl).hash.slice(1));
    const accessToken = fragment.get("access_token");
    const error = fragment.get("error");
    if (error || !accessToken) throw new Error(error || "Sign-in didn't return an access token.");
    return { accessToken, expiresIn: fragment.get("expires_in") };
  };

  // 1) Silent attempt (prompt=none, interactive:false): once the user has
  //    consented, Google hands back a fresh token with no window, so the
  //    hourly token expiry stops being something people notice.
  const silent = await launchFlow(buildAuthUrl("none"), false);
  if (!silent.error && silent.responseUrl) {
    try {
      const { accessToken, expiresIn } = parseTokenResponse(silent.responseUrl);
      await cacheToken(accessToken, expiresIn).catch(() => {});
      return accessToken;
    } catch {
      /* fall through to interactive */
    }
  }

  // 2) First run, or the session ended: show the visible account chooser.
  const interactive = await launchFlow(buildAuthUrl("select_account"), true);
  if (interactive.error || !interactive.responseUrl) {
    throw new Error(interactive.error || "Sign-in failed.");
  }
  const { accessToken, expiresIn } = parseTokenResponse(interactive.responseUrl);
  await cacheToken(accessToken, expiresIn).catch(() => {});
  return accessToken;
}

// ---------- API ----------

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// POSTs to the backend with a valid token; on a 401 (expired/revoked) it
// clears the cached token and retries once with a fresh one.
async function callApi(path, payload, { signal } = {}) {
  const send = async (token) => {
    try {
      return await fetch(`${BACKEND_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, accessToken: token }),
        signal,
      });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new ApiError("Couldn't reach the Mo server. Check your internet connection and try again.", 0);
    }
  };

  let res = await send(await getAuthToken());
  if (res.status === 401) {
    await clearCachedToken();
    res = await send(await getAuthToken());
  }

  if (!res.ok) {
    let serverMessage = "";
    try {
      serverMessage = (await res.json()).error || "";
    } catch {
      // response wasn't JSON — fall back to just the status
    }
    throw new ApiError(serverMessage || `Server error (${res.status})`, res.status);
  }
  return res.json();
}

// The file that highlights, comments and "don't flag again" state live on:
// the document itself, or the converted Google Docs copy for a Word file.
function effectiveDocId() {
  return lastCheckedDocId || currentDoc?.id;
}

// ---------- Saved state ----------

async function persist() {
  if (!currentDoc) return;
  const key = STATE_PREFIX + currentDoc.id;
  const snapshot = {
    type: selectedType,
    coding: selectedCoding,
    csoParty: selectedCsoParty,
    csoInviting: selectedCsoInviting,
    result: lastResult,
    checkedAt: lastCheckedAt,
    checkedDocId: lastCheckedDocId,
    resultKey: lastResultKey,
  };
  try {
    const { [STATE_INDEX_KEY]: index = [] } = await chrome.storage.local.get(STATE_INDEX_KEY);
    const next = index.filter((id) => id !== currentDoc.id).concat(currentDoc.id);
    const evicted = next.splice(0, Math.max(0, next.length - MAX_SAVED_DOCS));
    await chrome.storage.local.set({ [key]: snapshot, [STATE_INDEX_KEY]: next });
    if (evicted.length) await chrome.storage.local.remove(evicted.map((id) => STATE_PREFIX + id));
  } catch {
    // Saving is a convenience; never let it break a check.
  }
}

async function restore() {
  const key = STATE_PREFIX + currentDoc.id;
  const { [key]: saved } = await chrome.storage.local.get(key);
  if (!saved) return;

  selectedType = saved.type ?? null;
  selectedCoding = saved.coding ?? null;
  selectedCsoParty = saved.csoParty ?? null;
  selectedCsoInviting = saved.csoInviting ?? null;
  if (selectedType) typeCtl.set(selectedType, { silent: true, instant: true });
  if (selectedCoding) codingCtl.set(selectedCoding, { silent: true, instant: true });
  if (selectedCsoParty) partyCtl.set(selectedCsoParty, { silent: true, instant: true });
  if (selectedCsoInviting) invitingCtl.set(selectedCsoInviting, { silent: true, instant: true });
  syncVisibility();

  if (saved.result) {
    lastResult = saved.result;
    lastCheckedAt = saved.checkedAt;
    lastCheckedDocId = saved.checkedDocId;
    lastResultKey = saved.resultKey;
    renderResult();
  }
}

$("forgetBtn").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(STATE_PREFIX) || k === STATE_INDEX_KEY);
  if (keys.length) await chrome.storage.local.remove(keys);
  lastResult = lastCheckedAt = lastCheckedDocId = lastResultKey = null;
  archiveLoadedOnce = false;
  statusEl.replaceChildren();
  updateCheckBtn();
});

// ---------- Check ----------

let loadTimers = [];

function showLoading() {
  const step = h("div", {}, currentDoc?.isWord ? "Converting your Word file…" : "Reading the document…");
  const sub = h("div", { class: "footnote" });
  statusEl.replaceChildren(
    h(
      "div",
      { class: "loading", role: "status" },
      h("span", { class: "spinner", html: ICONS.spinner }),
      h("div", { class: "loading-text" }, step, sub),
      h("button", { class: "link-btn", type: "button", onclick: () => activeCheck?.abort() }, "Cancel")
    )
  );
  loadTimers = [
    setTimeout(() => (step.textContent = "Checking against the rulebook…"), 2500),
    setTimeout(
      () => (sub.textContent = "Still working — the server may be waking up. The first check can take up to a minute."),
      8000
    ),
  ];
}

function renderError(err) {
  statusEl.replaceChildren(
    h(
      "div",
      { class: "note warn" },
      h("span", { class: "glyph", html: ICONS.warn }),
      h("div", {}, h("strong", {}, "Couldn't complete the check"), h("p", {}, err.message))
    )
  );
}

checkBtn.addEventListener("click", async () => {
  if (!currentDoc || checkBtn.disabled) return;

  const controller = new AbortController();
  activeCheck = controller;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  showLoading();
  checkBtn.disabled = true;
  checkBtn.textContent = "Checking…";

  try {
    const result = await callApi(
      "/check",
      {
        docId: currentDoc.id,
        moaType: selectedType,
        codedSelection: selectedType === "sponsorship" ? selectedCoding : undefined,
        ...getInternalFlags(),
      },
      { signal: controller.signal }
    );

    lastResult = result;
    lastCheckedAt = Date.now();
    lastCheckedDocId = result.checkedDocId || currentDoc.id;
    lastResultKey = selectionKey();
    archiveLoadedOnce = false;
    renderResult();
    persist();
    statusEl.scrollIntoView({
      block: "nearest",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  } catch (err) {
    if (err.name === "AbortError") {
      if (timedOut) {
        renderError(new Error("The server took too long to respond. It may still be starting up — try again in a moment."));
      } else {
        statusEl.replaceChildren(); // the reviewer cancelled
      }
    } else {
      renderError(err);
    }
  } finally {
    clearTimeout(timeout);
    loadTimers.forEach(clearTimeout);
    activeCheck = null;
    updateCheckBtn();
  }
});

// ---------- Results ----------

function openCopy(url) {
  if (/^https:\/\/docs\.google\.com\/document\/d\/[\w-]+\/edit$/.test(url || "")) chrome.tabs.create({ url });
}

function conversionNote(c) {
  return h(
    "div",
    { class: "note" },
    h("span", { class: "glyph", html: ICONS.doc }),
    h(
      "div",
      {},
      h("strong", {}, "Marked on a Google Docs copy"),
      h(
        "p",
        {},
        c.reused
          ? "Reused the copy from your last check — your Word file hasn't changed since."
          : "Word files can't be edited in place, so Mo marked up a Google Docs copy. Your original is unchanged."
      ),
      c.replaced ? h("p", {}, "The previous copy was moved to your Drive trash.") : null,
      h("button", { class: "chip", type: "button", onclick: () => openCopy(c.copyUrl) }, "Open checked copy")
    )
  );
}

function issueRow(r, pdfMode) {
  const done = !!r.done;
  const actions = h("div", { class: "issue-actions" });

  if (DISMISSIBLE_ISSUE_TYPES.has(r.issue)) {
    actions.append(
      h(
        "button",
        { class: "chip", type: "button", disabled: done, onclick: (e) => dismissIssue(r, e.currentTarget) },
        done && r.done === "type" ? "Won't flag again ✓" : "Mark resolved — don't flag again"
      )
    );
  }
  if (!pdfMode) {
    actions.append(
      h(
        "button",
        { class: "chip", type: "button", disabled: done, onclick: (e) => markCorrect(r, e.currentTarget) },
        done && r.done === "instance" ? "Won't flag again ✓" : "Mark correct — don't flag again"
      )
    );
  }

  return h(
    "div",
    { class: `issue${done ? " done" : ""}` },
    h(
      "span",
      { class: `issue-status ${r.written ? "marked" : "unmarked"}` },
      pdfMode ? "To review" : r.written ? "Marked" : "Not written"
    ),
    h("div", { class: "issue-msg" }, r.message),
    !pdfMode && !r.written ? h("div", { class: "issue-reason" }, r.reason || "unknown reason") : null,
    actions.children.length ? actions : null
  );
}

async function copyIssues(btn) {
  const typeLabel = $("typeSeg").querySelector(`[data-value="${selectedType}"]`)?.textContent || "";
  const lines = [`Mo — ${currentDoc?.title || "document"}`, `${typeLabel} check, ${new Date(lastCheckedAt).toLocaleString()}`, ""];
  (lastResult.writeResults || []).forEach((r, i) => lines.push(`${i + 1}. ${r.message}`));
  if (lastResult.leadTimeOk === false) {
    lines.push("", `Past required lead time: ${lastResult.leadTimeDays} day(s) given, ${lastResult.requiredLeadTimeDays} required.`);
  }
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Couldn't copy";
  }
  setTimeout(() => (btn.textContent = "Copy list"), 1600);
}

function renderResult() {
  const result = lastResult;
  const {
    pdfMode,
    numPages,
    issueCount,
    markedCount,
    unmarkedCount,
    afterword,
    leadTimeOk,
    leadTimeDays,
    requiredLeadTimeDays,
    leadTimeNote,
    writeResults = [],
    commentsCleanedUp,
    conversion,
  } = result;

  const keepScroll = statusEl.querySelector(".issues")?.scrollTop || 0;
  const out = [];

  if (commentsCleanedUp > 0) {
    out.push(h("p", { class: "footnote" }, `Cleared ${plural(commentsCleanedUp, "outdated comment")} from a previous check.`));
  }
  if (pdfMode) {
    out.push(
      h("p", { class: "footnote" }, `PDF (${plural(numPages, "page")}) — checks are read-only; nothing is written back into the file.`)
    );
  }

  if (issueCount === 0) {
    out.push(
      h(
        "div",
        { class: "summary ok has-mascot" },
        h("img", { class: "mascot", src: "icons/mo-256.png", alt: "" }),
        h(
          "div",
          {},
          h("h2", {}, "Mo says a-ok"),
          h("p", {}, `No issues found in this document.${afterword ? ` ${afterword}` : ""}`)
        )
      )
    );
  } else {
    const where = conversion ? "checked copy" : "doc";
    const detail = pdfMode
      ? "Review each item below manually — PDF checks aren't written back into the file."
      : `${markedCount} highlighted and commented directly in the ${where}${
          unmarkedCount ? `, ${unmarkedCount} could not be written back automatically` : ""
        }.`;
    const copyBtn = h("button", { class: "chip", type: "button", onclick: (e) => copyIssues(e.currentTarget) }, "Copy list");
    out.push(
      h(
        "div",
        { class: "summary warn" },
        h("span", { class: "glyph", html: ICONS.warn }),
        h("div", {}, h("h2", {}, `${plural(issueCount, "issue")} found`), h("p", {}, detail), h("div", { class: "summary-actions" }, copyBtn))
      )
    );
  }

  if (conversion) out.push(conversionNote(conversion));

  if (issueCount > 0) {
    out.push(h("div", { class: "list issues scroll" }, writeResults.map((r) => issueRow(r, pdfMode))));
  }

  if (leadTimeOk === false) {
    out.push(
      h(
        "div",
        { class: "note warn" },
        h("span", { class: "glyph", html: ICONS.clock }),
        h(
          "div",
          {},
          h("strong", {}, "Past required lead time"),
          h("p", {}, `${leadTimeDays} day(s) given — ${requiredLeadTimeDays} required. A Justification Letter will be needed.`)
        )
      )
    );
  } else if (leadTimeOk === null && leadTimeNote) {
    out.push(
      h(
        "div",
        { class: "note warn" },
        h("span", { class: "glyph", html: ICONS.clock }),
        h("div", {}, h("strong", {}, "Lead time unclear"), h("p", {}, leadTimeNote))
      )
    );
  }

  if (lastCheckedAt) out.push(h("p", { class: "footnote" }, `Checked ${timeAgo(lastCheckedAt)}`));

  statusEl.replaceChildren(...out);
  const list = statusEl.querySelector(".issues");
  if (list) list.scrollTop = keepScroll;
  updateCheckBtn();
}

// Marks one issue type permanently resolved for the current document
// (see /dismiss-issue on the backend) so it stops being re-raised on
// future checks — used for "please check manually" issues only, once a
// reviewer has confirmed them by eye.
async function dismissIssue(r, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = "Marking resolved...";
  try {
    await callApi("/dismiss-issue", { docId: effectiveDocId(), issueType: r.issue });
    // The server mutes the whole type, so grey out every row of that type.
    lastResult.writeResults.forEach((w) => {
      if (w.issue === r.issue) w.done = "type";
    });
    persist();
    renderResult();
  } catch (err) {
    btnEl.disabled = false;
    btnEl.textContent = "Mark resolved — don't flag again";
    if (err.message) btnEl.title = err.message;
  }
}

// Marks one specific flagged INSTANCE as confirmed-correct for the current
// document (see /mark-correct on the backend), so /check stops re-raising
// this exact (type, text) pair — usable on any issue, unlike dismissIssue()
// above which mutes a whole issue type. A real violation elsewhere in the
// doc under the same issue type still gets flagged normally.
async function markCorrect(r, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = "Marking correct...";
  try {
    await callApi("/mark-correct", { docId: effectiveDocId(), issueType: r.issue, text: r.text ?? "" });
    r.done = "instance";
    persist();
    renderResult();
  } catch (err) {
    btnEl.disabled = false;
    btnEl.textContent = "Mark correct — don't flag again";
    // Size-cap errors from the backend are worth surfacing directly.
    if (err.message) btnEl.title = err.message;
  }
}

// ---------- Archive ----------

// Animated via the .open class (grid-rows transition in popup.css). Refetched
// every time it opens: an item may have self-healed (its underlying text got
// fixed) since last time, in which case it should quietly no longer be there.
let archiveLoadedOnce = false;
archiveToggleBtn.addEventListener("click", () => {
  const open = !archivePanel.classList.contains("open");
  setOpen(archivePanel, open);
  archiveToggleBtn.setAttribute("aria-expanded", String(open));
  if (open) loadArchive();
});

function archiveMessage(text) {
  archiveList.replaceChildren(h("p", { class: "archive-empty" }, text));
}

async function loadArchive() {
  if (!lastResult || !currentDoc || !selectedType) {
    archiveMessage("Run a check first, then open the archive.");
    return;
  }
  if (!archiveLoadedOnce) archiveMessage("Loading…");

  try {
    const { archive } = await callApi("/archive", {
      docId: effectiveDocId(),
      moaType: selectedType,
      codedSelection: selectedCoding,
      ...getInternalFlags(),
    });
    archiveLoadedOnce = true;
    renderArchive(archive);
  } catch (err) {
    archiveMessage(`Couldn't load the archive${err.message ? `: ${err.message}` : ""}.`);
  }
}

function renderArchive(entries) {
  if (!entries || entries.length === 0) {
    archiveMessage("Nothing dismissed yet for this document.");
    return;
  }
  archiveList.replaceChildren(
    h(
      "div",
      { class: "list" },
      entries.map((entry) =>
        h(
          "div",
          { class: "archive-item" },
          h(
            "div",
            { class: "archive-msg" },
            entry.message,
            h("span", { class: "archive-kind" }, entry.kind === "type" ? "Dismissed type" : "Marked correct")
          ),
          h("button", { class: "chip", type: "button", onclick: (e) => restoreArchiveItem(entry, e.currentTarget) }, "Restore")
        )
      )
    )
  );
}

async function restoreArchiveItem(entry, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = "Restoring...";
  try {
    await callApi("/restore-issue", {
      docId: effectiveDocId(),
      kind: entry.kind,
      issueType: entry.issueType,
      hash: entry.hash,
    });
    btnEl.closest(".archive-item")?.remove();
    if (!archiveList.querySelector(".archive-item")) archiveMessage("Nothing dismissed yet for this document.");
  } catch (err) {
    btnEl.disabled = false;
    btnEl.textContent = "Restore";
    if (err.message) btnEl.title = err.message;
  }
}

// ---------- Init ----------

(async function init() {
  $("versionLabel").textContent = `Mo v${chrome.runtime.getManifest().version}`;
  syncVisibility();
  try {
    currentDoc = await detectDocument();
  } catch {
    currentDoc = null;
  }
  renderDocCard();
  if (currentDoc) {
    wakeServer();
    await restore();
  }
  updateCheckBtn();
})();

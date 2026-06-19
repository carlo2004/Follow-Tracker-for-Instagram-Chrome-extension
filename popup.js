/*
 * popup.js — dashboard logic for the extension popup.
 *
 * Responsibilities:
 *   - Trigger a scan: read the session cookie, find/open an instagram.com tab,
 *     inject content.js, and tell it to start.
 *   - Read scan results + whitelist from chrome.storage.local and render lists.
 *   - Show real profile pictures (with an initials fallback).
 *   - Load per-account follower/following/post counts on demand (single or batch).
 *   - Manage the whitelist (add / remove).
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  result: null, // { scannedAt, userId, following:[], followers:[] }
  whitelist: [], // array of usernames (case preserved, compared lowercase)
  status: null, // scan status object
  statsCache: {}, // { usernameLower: { followers, following, posts, profile_pic_url, ... } }
  statsLoading: {}, // { usernameLower: true } while a fetch is in flight
  tab: "nonfollowers",
  query: "",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
const BATCH_LIMIT = 25; // max accounts a single "Load stats" batch will fetch
let unfollowBusy = false; // guard so a stray double-click can't fire two unfollows
const avatarCache = new Map(); // profile_pic_url -> object URL (cached for the popup session)
let avatarObserver = null; // lazy-loads avatars as their rows scroll into view

/* ---------- storage ---------- */

function load() {
  chrome.storage.local.get(["scanResult", "whitelist", "scanStatus", "userStats"], (res) => {
    state.result = res.scanResult || null;
    state.whitelist = res.whitelist || [];
    state.status = res.scanStatus || null;
    state.statsCache = res.userStats || {};
    render();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.scanResult) state.result = changes.scanResult.newValue || null;
  if (changes.whitelist) state.whitelist = changes.whitelist.newValue || [];
  if (changes.scanStatus) state.status = changes.scanStatus.newValue || null;
  if (changes.userStats) state.statsCache = changes.userStats.newValue || {};
  render();
});

function saveWhitelist(list) {
  state.whitelist = list;
  chrome.storage.local.set({ whitelist: list });
}
function addWhitelist(username) {
  const lower = username.toLowerCase();
  if (!state.whitelist.some((s) => s.toLowerCase() === lower)) saveWhitelist([...state.whitelist, username]);
}
function removeWhitelist(username) {
  const lower = username.toLowerCase();
  saveWhitelist(state.whitelist.filter((s) => s.toLowerCase() !== lower));
}

/* ---------- derived data ---------- */

function computeLists() {
  const r = state.result;
  if (!r) return { nonFollowers: [], fans: [], whitelisted: [], followingCount: 0, followersCount: 0 };
  const following = r.following || [];
  const followers = r.followers || [];
  const followerPks = new Set(followers.map((u) => u.pk));
  const followingPks = new Set(following.map((u) => u.pk));
  const wl = new Set(state.whitelist.map((s) => s.toLowerCase()));

  const nonFollowers = following
    .filter((u) => !followerPks.has(u.pk))
    .filter((u) => !wl.has((u.username || "").toLowerCase()));
  const fans = followers.filter((u) => !followingPks.has(u.pk));

  const byUser = {};
  [...following, ...followers].forEach((u) => { byUser[(u.username || "").toLowerCase()] = u; });
  const whitelisted = state.whitelist.map(
    (name) => byUser[name.toLowerCase()] || { username: name, full_name: "", pk: "", is_private: false, is_verified: false }
  );

  return { nonFollowers, fans, whitelisted, followingCount: following.length, followersCount: followers.length };
}

function getVisibleItems() {
  const data = computeLists();
  let items = state.tab === "nonfollowers" ? data.nonFollowers : state.tab === "fans" ? data.fans : data.whitelisted;
  const q = state.query.trim().toLowerCase();
  if (q) items = items.filter((u) => (u.username || "").toLowerCase().includes(q) || (u.full_name || "").toLowerCase().includes(q));
  return { items, data };
}

/* ---------- formatting / elements ---------- */

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString() : "never";
}

function fmtCount(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(n);
}

function avatar(username, picUrl) {
  const colors = ["#e1306c", "#405de6", "#5851db", "#833ab4", "#c13584", "#fd1d1d", "#f56040", "#fcaf45"];
  let h = 0;
  for (const c of username || "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const wrap = document.createElement("div");
  wrap.className = "avatar";
  wrap.style.background = colors[h % colors.length];
  wrap.textContent = (username || "?").charAt(0).toUpperCase(); // fallback shown behind image
  if (picUrl) {
    const img = document.createElement("img");
    img.className = "avatar-img";
    img.alt = "";
    img.addEventListener("error", () => img.remove()); // keep initials if it fails
    if (avatarCache.has(picUrl)) {
      img.src = avatarCache.get(picUrl); // already fetched this session
    } else {
      img.style.display = "none"; // revealed once loaded; initials show meanwhile
      img.dataset.src = picUrl;
    }
    wrap.appendChild(img);
  }
  return wrap;
}

// Instagram serves profile pictures from fbcdn / cdninstagram, which reject
// hot-linking from an <img> on another origin. The popup is an extension page
// WITH host permission for those CDNs, so it can fetch the bytes directly
// (CORS relaxed) and display them via an object URL. Done lazily per row.
function ensureAvatarObserver() {
  if (avatarObserver) return avatarObserver;
  avatarObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          loadAvatarImage(e.target);
          avatarObserver.unobserve(e.target);
        }
      }
    },
    { root: $("#list"), rootMargin: "150px" }
  );
  return avatarObserver;
}

function observeAvatar(img) {
  ensureAvatarObserver().observe(img);
}

function loadAvatarImage(img) {
  const url = img.dataset.src;
  if (!url) return;
  if (avatarCache.has(url)) {
    img.src = avatarCache.get(url);
    img.style.display = "";
    return;
  }
  fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.blob();
    })
    .then((blob) => {
      const objUrl = URL.createObjectURL(blob);
      avatarCache.set(url, objUrl);
      img.src = objUrl;
      img.style.display = "";
    })
    .catch(() => {
      img.remove(); // leave the colored initials
    });
}

function badge(text, cls) {
  const s = document.createElement("span");
  s.className = "badge " + (cls || "");
  s.textContent = text;
  return s;
}

function openProfile(username) {
  chrome.tabs.create({ url: "https://www.instagram.com/" + encodeURIComponent(username) + "/" });
}

function row(u) {
  const key = (u.username || "").toLowerCase();
  const stats = state.statsCache[key];
  const loading = state.statsLoading[key];
  const picUrl = (stats && stats.profile_pic_url) || u.profile_pic_url || "";

  const li = document.createElement("div");
  li.className = "row";

  const av = avatar(u.username, picUrl);
  av.title = "Open profile";
  av.style.cursor = "pointer";
  av.addEventListener("click", () => openProfile(u.username));
  li.appendChild(av);

  const meta = document.createElement("div");
  meta.className = "meta";

  const top = document.createElement("div");
  top.className = "uname";
  const a = document.createElement("a");
  a.href = "#";
  a.textContent = "@" + u.username;
  a.title = "Open profile in a new tab";
  a.addEventListener("click", (e) => { e.preventDefault(); openProfile(u.username); });
  top.appendChild(a);
  if (u.is_verified) top.appendChild(badge("verified", "verified"));
  if (u.is_private) top.appendChild(badge("private", ""));
  meta.appendChild(top);

  if (u.full_name) {
    const fn = document.createElement("div");
    fn.className = "fname";
    fn.textContent = u.full_name;
    meta.appendChild(fn);
  }

  // Stats line: cached counts, a spinner, or a "Load stats" link.
  const statline = document.createElement("div");
  statline.className = "statline";
  if (stats) {
    statline.textContent =
      `${fmtCount(stats.followers)} followers · ${fmtCount(stats.following)} following · ${fmtCount(stats.posts)} posts`;
  } else if (loading) {
    statline.textContent = "loading stats...";
    statline.classList.add("muted");
  } else {
    const b = document.createElement("button");
    b.className = "linkbtn";
    b.textContent = "Load stats";
    b.title = "Fetch this account's follower / following / post counts";
    b.addEventListener("click", () => loadOneStat(u.username));
    statline.appendChild(b);
  }
  meta.appendChild(statline);
  li.appendChild(meta);

  const wrap = document.createElement("div");
  wrap.className = "actions";
  let actions;
  if (state.tab === "whitelist") {
    actions = [
      { label: "Open", cls: "ghost", onClick: () => openProfile(u.username) },
      { label: "Remove", cls: "danger", onClick: () => removeWhitelist(u.username) },
    ];
  } else if (state.tab === "fans") {
    actions = [{ label: "Open", cls: "ghost", onClick: () => openProfile(u.username) }];
  } else {
    actions = [
      { label: "Unfollow", cls: "primary", title: "Unfollow this account now", onClick: (btn) => handleUnfollow(u, btn) },
      { label: "Keep", cls: "ghost", title: "Whitelist — keep following even though they don't follow back", onClick: () => addWhitelist(u.username) },
    ];
  }
  actions.forEach((act) => {
    const b = document.createElement("button");
    b.className = "btn " + (act.cls || "");
    b.textContent = act.label;
    b.title = act.title || act.label;
    b.addEventListener("click", () => act.onClick(b));
    wrap.appendChild(b);
  });
  li.appendChild(wrap);
  return li;
}

function emptyMsg(text) {
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = text;
  return d;
}

function setProgress(text, isError) {
  const prog = $("#progress");
  prog.textContent = text;
  prog.classList.toggle("err", !!isError);
  prog.style.display = text ? "" : "none";
}

/* ---------- rendering ---------- */

function render() {
  // rows are rebuilt every render, so reset the lazy-avatar observer
  if (avatarObserver) {
    avatarObserver.disconnect();
    avatarObserver = null;
  }
  const { items, data } = getVisibleItems();

  $("#stat-following").textContent = state.result ? data.followingCount : "—";
  $("#stat-followers").textContent = state.result ? data.followersCount : "—";
  $("#stat-nonfollowers").textContent = state.result ? data.nonFollowers.length : "—";
  $("#stat-whitelist").textContent = state.whitelist.length;
  $("#last-scan").textContent = "Last scan: " + fmtTime(state.result && state.result.scannedAt);

  const st = state.status || {};
  const scanBtn = $("#scan-btn");
  const cancelBtn = $("#cancel-btn");

  if (st.running) {
    scanBtn.disabled = true;
    scanBtn.textContent = "Scanning...";
    cancelBtn.style.display = "";
    let label = "Working...";
    if (st.phase === "following") label = `Loading accounts you follow... ${st.currentCount || 0}`;
    else if (st.phase === "followers") label = `Loading your followers... ${st.currentCount || 0}`;
    if (st.note) label += " — " + st.note;
    setProgress(label, false);
  } else {
    scanBtn.disabled = false;
    scanBtn.textContent = state.result ? "Re-scan" : "Scan now";
    cancelBtn.style.display = "none";
    if (st.error) setProgress("Error: " + st.error, true);
    else if (!$("#progress").classList.contains("err")) setProgress("", false);
  }

  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.tab));

  const listEl = $("#list");
  listEl.innerHTML = "";

  if (!state.result && state.tab !== "whitelist") {
    listEl.appendChild(emptyMsg('No data yet. Click "Scan now" to load your followers and following.'));
    return;
  }
  if (items.length === 0) {
    const q = state.query.trim();
    const msgs = {
      nonfollowers: q ? "No matches." : "Nobody to show — everyone you follow follows you back (or is whitelisted). 🎉",
      fans: q ? "No matches." : "No one-way followers found.",
      whitelist: q ? "No matches." : 'Your whitelist is empty. Use "Keep" on the "Doesn\'t follow back" tab to protect accounts.',
    };
    listEl.appendChild(emptyMsg(msgs[state.tab]));
    return;
  }

  const frag = document.createDocumentFragment();
  items.forEach((u) => frag.appendChild(row(u)));
  listEl.appendChild(frag);

  // now that rows are attached, lazy-load each avatar when it scrolls into view
  listEl.querySelectorAll("img.avatar-img[data-src]").forEach((img) => observeAvatar(img));
}

/* ---------- instagram tab helpers ---------- */

function getCookie(name) {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: "https://www.instagram.com", name }, (c) => resolve(c ? c.value : null));
  });
}
function queryTabs(q) { return new Promise((res) => chrome.tabs.query(q, res)); }
function createTab(opts) { return new Promise((res) => chrome.tabs.create(opts, res)); }

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return reject(new Error("Tab was closed."));
        if (tab.status === "complete") return resolve(tab);
        if (Date.now() - started > timeoutMs) return resolve(tab);
        setTimeout(check, 400);
      });
    };
    check();
  });
}
async function ensureInstagramTab() {
  const tabs = await queryTabs({ url: "https://www.instagram.com/*" });
  if (tabs && tabs.length) return tabs[0];
  const tab = await createTab({ url: "https://www.instagram.com/", active: false });
  await waitForTabComplete(tab.id);
  return tab;
}
function injectContent(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
function sendMessage(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { ok: true });
    });
  });
}
async function ensureTabReady() {
  const tab = await ensureInstagramTab();
  await injectContent(tab.id);
  return tab.id;
}

/* ---------- scanning ---------- */

async function handleScan() {
  setProgress("Preparing...", false);

  const userId = await getCookie("ds_user_id");
  const csrf = await getCookie("csrftoken");

  if (!userId) {
    setProgress("You're not logged into Instagram. Opening the login page...", true);
    chrome.tabs.create({ url: "https://www.instagram.com/accounts/login/" });
    return;
  }

  let tab;
  try {
    tab = { id: await ensureTabReady() };
  } catch (e) {
    setProgress("Could not open Instagram: " + e.message, true);
    return;
  }

  let resp = await sendMessage(tab.id, { type: "START_SCAN", userId, csrf });
  if (!resp || resp.ok === false) {
    try {
      await injectContent(tab.id);
      resp = await sendMessage(tab.id, { type: "START_SCAN", userId, csrf });
    } catch (e) {
      resp = { ok: false, error: e.message };
    }
  }

  if (resp && resp.ok) {
    chrome.storage.local.set({
      scanStatus: { running: true, phase: "following", currentCount: 0, note: "", error: null, startedAt: Date.now() },
    });
  } else {
    setProgress("Could not start scan: " + ((resp && resp.error) || "no response") + ". Open instagram.com in a tab and try again.", true);
  }
}

async function handleCancel() {
  const tabs = await queryTabs({ url: "https://www.instagram.com/*" });
  for (const t of tabs) await sendMessage(t.id, { type: "CANCEL_SCAN" });
  chrome.storage.local.get(["scanStatus"], (res) => {
    const next = Object.assign({}, res.scanStatus || {}, { running: false, phase: "cancelled", note: "" });
    chrome.storage.local.set({ scanStatus: next });
  });
}

/* ---------- unfollow ---------- */

// Ensure an instagram.com tab with content.js, then message it.
async function callContent(msg) {
  const tabId = await ensureTabReady();
  return sendMessage(tabId, msg);
}

// Drop an account from the stored "following" list after we unfollow it,
// so the row disappears and the Following count stays accurate.
function removeFromFollowing(pk) {
  if (!state.result) return;
  state.result.following = (state.result.following || []).filter((x) => x.pk !== pk);
  chrome.storage.local.set({ scanResult: state.result });
  render();
}

// Close any open Chrome tabs that are showing this account's profile
// (matches the first path segment exactly, so "maria" won't close "maria.gbl1",
// and instagram.com/explore, /reels, the home feed, etc. are left alone).
async function closeProfileTabs(username) {
  const uname = (username || "").toLowerCase();
  if (!uname) return 0;
  const tabs = await queryTabs({ url: "*://*.instagram.com/*" });
  const ids = [];
  for (const t of tabs) {
    if (!t.url || t.id == null) continue;
    try {
      const firstSeg = new URL(t.url).pathname.split("/").filter(Boolean)[0] || "";
      if (firstSeg.toLowerCase() === uname) ids.push(t.id);
    } catch (e) {
      /* ignore unparseable tab urls */
    }
  }
  if (ids.length) await new Promise((res) => chrome.tabs.remove(ids, () => res()));
  return ids.length;
}

async function handleUnfollow(u, btn) {
  if (unfollowBusy) return;
  if (!u.pk) {
    // No numeric id available (rare) — fall back to opening the profile.
    openProfile(u.username);
    return;
  }

  // One-time acknowledgement of the risk before enabling in-app unfollow.
  const ack = await new Promise((res) =>
    chrome.storage.local.get(["unfollowAck"], (r) => res(!!r.unfollowAck))
  );
  if (!ack) {
    const ok = window.confirm(
      "Unfollow directly from the extension?\n\n" +
        "This unfollows accounts through Instagram's private API. Unfollowing many people quickly can trigger a temporary Instagram action-block, so go slowly.\n\n" +
        "Click OK to enable one-click unfollow (shown only once)."
    );
    if (!ok) return;
    await new Promise((res) => chrome.storage.local.set({ unfollowAck: true }, res));
  }

  unfollowBusy = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Unfollowing...";
  }
  setProgress("Unfollowing @" + u.username + "...", false);

  try {
    const resp = await callContent({ type: "UNFOLLOW", userId: u.pk });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || "Unfollow failed.");
    await closeProfileTabs(u.username); // close any open tabs of this profile
    removeFromFollowing(u.pk); // row vanishes + Following count drops
  } catch (e) {
    setProgress(e.message, true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Unfollow";
    }
  } finally {
    // brief cooldown so accidental rapid clicks can't fire a burst
    setTimeout(() => {
      unfollowBusy = false;
    }, 1200);
  }
}

/* ---------- per-account stats ---------- */

async function fetchStats(username) {
  const key = username.toLowerCase();
  if (state.statsCache[key]) return state.statsCache[key];
  const tabId = await ensureTabReady();
  const resp = await sendMessage(tabId, { type: "FETCH_USER_STATS", username });
  if (resp && resp.ok && resp.stats) {
    state.statsCache[key] = resp.stats;
    chrome.storage.local.set({ userStats: state.statsCache });
    return resp.stats;
  }
  throw new Error((resp && resp.error) || "Could not load stats.");
}

async function loadOneStat(username) {
  const key = username.toLowerCase();
  state.statsLoading[key] = true;
  render();
  try {
    await fetchStats(username);
    if (!$("#progress").classList.contains("err")) setProgress("", false);
  } catch (e) {
    setProgress(e.message, true);
  } finally {
    delete state.statsLoading[key];
    render();
  }
}

async function loadVisibleStats() {
  const { items } = getVisibleItems();
  const todo = items
    .filter((u) => u.username && !state.statsCache[u.username.toLowerCase()])
    .slice(0, BATCH_LIMIT);

  if (todo.length === 0) {
    setProgress("Stats already loaded for the visible list.", false);
    return;
  }

  todo.forEach((u) => { state.statsLoading[u.username.toLowerCase()] = true; });
  render();

  let done = 0;
  for (const u of todo) {
    const key = u.username.toLowerCase();
    try {
      await fetchStats(u.username);
      done++;
      setProgress(`Loading stats... ${done}/${todo.length}`, false);
    } catch (e) {
      delete state.statsLoading[key];
      setProgress(e.message + " Loaded " + done + " before stopping.", true);
      render();
      return; // stop the batch on error (usually a rate limit)
    } finally {
      delete state.statsLoading[key];
      render();
    }
    await sleep(rand(1200, 2600)); // pace requests
  }
  setProgress(`Loaded stats for ${done} account${done === 1 ? "" : "s"}.`, false);
}

/* ---------- export ---------- */

function exportCsv() {
  const { items } = getVisibleItems();
  const rows = [["username", "full_name", "is_private", "is_verified", "followers", "following", "posts", "profile_url"]];
  items.forEach((u) => {
    const s = state.statsCache[(u.username || "").toLowerCase()] || {};
    rows.push([
      u.username,
      u.full_name || "",
      u.is_private ? "yes" : "no",
      u.is_verified ? "yes" : "no",
      s.followers != null ? s.followers : "",
      s.following != null ? s.following : "",
      s.posts != null ? s.posts : "",
      "https://www.instagram.com/" + u.username + "/",
    ]);
  });
  const csv = rows
    .map((r) => r.map((f) => (/[",\n]/.test(String(f)) ? '"' + String(f).replace(/"/g, '""') + '"' : String(f))).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "instagram-" + state.tab + ".csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- wire up ---------- */

document.addEventListener("DOMContentLoaded", () => {
  $("#scan-btn").addEventListener("click", handleScan);
  $("#cancel-btn").addEventListener("click", handleCancel);
  $("#stats-btn").addEventListener("click", loadVisibleStats);
  $("#export-btn").addEventListener("click", exportCsv);
  $("#search").addEventListener("input", (e) => { state.query = e.target.value; render(); });
  $$(".tab").forEach((t) =>
    t.addEventListener("click", () => { state.tab = t.dataset.tab; state.query = ""; $("#search").value = ""; render(); })
  );
  load();
});

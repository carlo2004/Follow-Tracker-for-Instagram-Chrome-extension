/*
 * content.js
 * Injected into an instagram.com tab to read the logged-in user's
 * "following" and "followers" lists via Instagram's own web endpoints.
 *
 * Because this code runs INSIDE instagram.com, the requests are same-origin
 * and the session cookies are sent automatically (just like the website's
 * own JavaScript). Results and progress are written to chrome.storage.local
 * so the popup can read them even if it is closed mid-scan.
 */
(() => {
  // Guard against being injected more than once into the same page.
  if (window.__followTrackerInjected) return;
  window.__followTrackerInjected = true;

  const APP_ID = "936619743392459"; // Instagram web app id required by /api/v1
  const PAGE_SIZE = 50;
  const STORAGE = chrome.storage.local;

  let scanning = false;
  let cancelRequested = false;
  let wwwClaim = "0"; // x-ig-www-claim, updated from response headers when present

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

  // csrftoken is not httpOnly, so the content script can read it directly.
  function getCsrf() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? m[1] : "";
  }

  // Merge a patch into the persisted scan status object.
  function setStatus(patch) {
    return new Promise((resolve) => {
      STORAGE.get(["scanStatus"], (res) => {
        const next = Object.assign({}, res.scanStatus || {}, patch);
        STORAGE.set({ scanStatus: next }, resolve);
      });
    });
  }

  async function apiGet(path, csrf) {
    const headers = {
      "x-ig-app-id": APP_ID,
      "x-requested-with": "XMLHttpRequest",
      "x-csrftoken": csrf || "",
    };
    if (wwwClaim) headers["x-ig-www-claim"] = wwwClaim;

    const resp = await fetch(path, {
      method: "GET",
      headers,
      credentials: "include",
    });

    // Capture the rolling www-claim token Instagram hands back.
    const claim = resp.headers.get("x-ig-set-www-claim");
    if (claim) wwwClaim = claim;
    return resp;
  }

  // Paginate one friendship list. kind = "followers" | "following".
  async function fetchList(kind, userId, csrf, onProgress) {
    const out = [];
    let maxId = null;
    let safetyRetries = 0;

    while (true) {
      if (cancelRequested) throw new Error("Scan cancelled.");

      const params = new URLSearchParams({ count: String(PAGE_SIZE) });
      if (maxId) params.set("max_id", maxId);
      const url = `/api/v1/friendships/${userId}/${kind}/?${params.toString()}`;

      let resp;
      try {
        resp = await apiGet(url, csrf);
      } catch (netErr) {
        // Transient network error: wait briefly and retry the same page.
        if (safetyRetries++ > 4) throw new Error("Network error talking to Instagram.");
        await onProgress({ count: out.length, note: "Network hiccup, retrying..." });
        await sleep(4000);
        continue;
      }

      if (resp.status === 429) {
        // Rate limited. Back off and retry the same page (do not advance maxId).
        await onProgress({ count: out.length, note: "Instagram rate limit hit - waiting 60s..." });
        await sleep(60000);
        continue;
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new Error("Not authorized. Open instagram.com, make sure you are logged in, then retry.");
      }
      if (!resp.ok) {
        throw new Error(`Instagram returned HTTP ${resp.status} while loading ${kind}.`);
      }

      let data;
      try {
        data = await resp.json();
      } catch (e) {
        throw new Error("Unexpected response from Instagram (are you logged in?).");
      }

      const users = Array.isArray(data.users) ? data.users : [];
      for (const u of users) {
        out.push({
          pk: String(u.pk || u.id || u.pk_id || ""),
          username: u.username || "",
          full_name: u.full_name || "",
          is_private: !!u.is_private,
          is_verified: !!u.is_verified,
          profile_pic_url: u.profile_pic_url || "",
        });
      }
      safetyRetries = 0;
      await onProgress({ count: out.length, note: "" });

      maxId = data.next_max_id || null;
      if (!maxId) break;

      // Polite randomized delay between pages to stay under the radar.
      await sleep(rand(1500, 3500));
    }
    return out;
  }

  async function runScan(userId, csrf) {
    cancelRequested = false;
    wwwClaim = "0";

    await setStatus({
      running: true,
      phase: "following",
      error: null,
      note: "",
      currentCount: 0,
      followingCount: null,
      followersCount: null,
      startedAt: Date.now(),
      finishedAt: null,
    });

    // 1) Accounts the user follows.
    const following = await fetchList("following", userId, csrf, (p) =>
      setStatus({ phase: "following", currentCount: p.count, note: p.note || "" })
    );
    await setStatus({ followingCount: following.length, currentCount: 0, phase: "followers", note: "" });

    // 2) Accounts that follow the user.
    const followers = await fetchList("followers", userId, csrf, (p) =>
      setStatus({ phase: "followers", currentCount: p.count, note: p.note || "" })
    );

    const result = {
      scannedAt: Date.now(),
      userId: String(userId),
      following,
      followers,
    };

    await new Promise((res) => STORAGE.set({ scanResult: result }, res));
    await setStatus({
      running: false,
      phase: "done",
      followingCount: following.length,
      followersCount: followers.length,
      currentCount: 0,
      note: "",
      error: null,
      finishedAt: Date.now(),
    });
  }

  // Fetch follower/following/post counts for a single account, on demand.
  // (Per-account because the friendship lists don't include these numbers.)
  async function fetchUserStats(username) {
    const url = `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const resp = await apiGet(url, getCsrf());
    if (resp.status === 429) throw new Error("Instagram rate-limited stats - wait a bit before loading more.");
    if (resp.status === 404) throw new Error("Profile not found (account may be deleted or renamed).");
    if (!resp.ok) throw new Error("Instagram returned HTTP " + resp.status + " for stats.");

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw new Error("Unexpected stats response from Instagram.");
    }
    const u = data && data.data && data.data.user;
    if (!u) throw new Error("No profile data returned.");
    return {
      followers: u.edge_followed_by ? u.edge_followed_by.count : null,
      following: u.edge_follow ? u.edge_follow.count : null,
      posts: u.edge_owner_to_timeline_media ? u.edge_owner_to_timeline_media.count : null,
      full_name: u.full_name || "",
      is_private: !!u.is_private,
      is_verified: !!u.is_verified,
      profile_pic_url: u.profile_pic_url_hd || u.profile_pic_url || "",
      fetchedAt: Date.now(),
    };
  }

  // Unfollow a single account by its numeric id (pk) via Instagram's own
  // endpoint. POST requires the csrf token. Detects anti-spam action blocks.
  async function unfollowUser(userId) {
    const headers = {
      "x-ig-app-id": APP_ID,
      "x-csrftoken": getCsrf(),
      "x-requested-with": "XMLHttpRequest",
      "content-type": "application/x-www-form-urlencoded",
    };
    if (wwwClaim) headers["x-ig-www-claim"] = wwwClaim;

    const resp = await fetch(`/api/v1/friendships/destroy/${userId}/`, {
      method: "POST",
      headers,
      body: "user_id=" + encodeURIComponent(userId),
      credentials: "include",
    });
    const claim = resp.headers.get("x-ig-set-www-claim");
    if (claim) wwwClaim = claim;

    if (resp.status === 429) throw new Error("Instagram rate-limited unfollows - wait a while before continuing.");
    if (resp.status === 401 || resp.status === 403) throw new Error("Not authorized - make sure you are logged in.");

    let data = {};
    try {
      data = await resp.json();
    } catch (e) {
      /* some responses have no body */
    }
    if (data && (data.message === "feedback_required" || data.spam)) {
      throw new Error("Instagram temporarily blocked this action (anti-spam). Stop unfollowing for a few hours.");
    }
    if (!resp.ok || (data && data.status && data.status !== "ok")) {
      throw new Error("Unfollow failed (HTTP " + resp.status + ").");
    }
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "PING") {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "CANCEL_SCAN") {
      cancelRequested = true;
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "START_SCAN") {
      if (scanning) {
        sendResponse({ ok: true, already: true });
        return;
      }
      scanning = true;
      runScan(msg.userId, msg.csrf || getCsrf())
        .catch((e) =>
          setStatus({ running: false, phase: "error", error: (e && e.message) || String(e) })
        )
        .finally(() => {
          scanning = false;
        });
      // Respond immediately; progress is reported through chrome.storage.
      sendResponse({ ok: true, started: true });
      return;
    }
    if (msg.type === "FETCH_USER_STATS") {
      fetchUserStats(msg.username)
        .then((stats) => sendResponse({ ok: true, stats }))
        .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
      return true; // async response
    }
    if (msg.type === "UNFOLLOW") {
      unfollowUser(msg.userId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
      return true; // async response
    }
  });
})();

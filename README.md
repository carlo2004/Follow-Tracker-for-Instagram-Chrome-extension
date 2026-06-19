# Follow Tracker for Instagram

A Chrome (Manifest V3) extension that shows **who doesn't follow you back** on Instagram, lets you **whitelist** accounts you want to keep following anyway, and **unfollow** non-followers with a single click.

Everything runs locally in your browser. Your follower/following lists never leave your device — there is no server, no account, no third-party login.

---

## What it does

- **Tracks who you follow** and **who follows you back** by reading your own lists from Instagram while you're logged in.
- **Profile pictures** for every account (with a colored-initials fallback if an image fails to load).
- **"Doesn't follow back"** tab — everyone you follow who doesn't follow you, with a one-click **Unfollow** button (unfollows immediately, in place) and **Keep** (whitelist).
- **Fans** tab — people who follow you that you don't follow back.
- **Whitelist** tab — accounts you've chosen to keep; they're hidden from the "doesn't follow back" list.
- **On-demand follower / following / post counts** per account — load one at a time, or up to 25 of the visible list at once. Counts are cached so you only fetch them once.
- **Search** and **CSV export** (the CSV includes any counts you've loaded) for any list.

---

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3): permissions and the popup action. |
| `content.js` | Runs inside instagram.com; fetches your following/followers (with pagination + rate-limit handling), per-account stats, and performs unfollows. |
| `popup.html` | The dashboard UI. |
| `popup.css` | Styling. |
| `popup.js` | UI logic: scans, list rendering, profile pictures, whitelist, stats, one-click unfollow, and CSV export. |

---

## Setup / Installation

This is an **unpacked** extension, so you load it directly — no Chrome Web Store needed.

1. Keep all the files together in one folder (it must contain `manifest.json` at the top level).
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Open the puzzle-piece menu in your toolbar and pin **Follow Tracker** for easy access. (The extension uses Chrome's default icon.)

Works in any Chromium browser that supports MV3: Chrome, Edge, Brave, Arc, Opera.

---

## Usage Guide

### Run a scan
1. Make sure you're **logged into Instagram** in the same browser (open instagram.com once if unsure).
2. Click the extension icon, then **Scan now**.
3. The extension opens/uses an instagram.com tab and loads your lists. Progress shows live (e.g. *"Loading your followers… 250"*). Large accounts take a while because the extension deliberately paces requests to avoid Instagram's rate limits.
4. You can close the popup — the scan keeps running and saves its results. Reopen the popup any time to see progress or results.

### View people who don't follow you back
- Open the **"Doesn't follow back"** tab (the default). It lists every account you follow that isn't following you, minus anything you've whitelisted. The stat box at the top shows the count.

### Whitelist an account (keep following even if they don't follow back)
- On the "Doesn't follow back" tab, click **Keep** next to anyone you want to protect (brands, friends, celebrities, etc.).
- They immediately disappear from the "doesn't follow back" list and move to the **Whitelist** tab.
- To stop protecting them, open the **Whitelist** tab and click **Remove**.
- The whitelist is saved locally and persists across future scans.

### See follower / following / post counts
- These aren't included in Instagram's list data, so they're fetched per account on demand. Click **Load stats** under any row to fetch that one account, or click the **Stats** button in the toolbar to load counts for up to 25 of the currently visible accounts at once.
- Counts are cached locally, so re-opening the popup or re-running won't re-fetch them. If Instagram rate-limits the requests, the batch stops and tells you — wait a minute and continue.

### Unfollow someone
- Click the **Unfollow** button on any row and the account is unfollowed immediately, in place — the row then disappears and your Following count drops. No need to leave the popup.
- Any Chrome tabs you have open on that person's profile are closed automatically right after the unfollow succeeds.
- The first time, you'll get a one-time confirmation explaining the action-block risk; after you accept it, unfollows are one click each.
- Clicking the **@username** (or the avatar) still just opens the profile in a new tab, in case you'd rather review someone before removing them.
- Please pace yourself — see **Important Notes** about Instagram action-blocks.

### Export
- Click **Export** to download the current tab's list as a CSV (username, name, private/verified flags, any loaded follower/following/post counts, and profile URL).

---

## Important Notes, Limitations & Privacy

**There is no official Instagram API for this.** Instagram's Graph API only returns follower *counts* and aggregate demographics — never the actual list of who follows you or who you follow. The old Basic Display API that personal accounts used was fully shut down on **December 4, 2024**. So the only way to compare your lists is to read them the same way the Instagram website itself does, while you're logged in. That's what this extension does.

**Terms of Service.** Programmatically reading these lists, and especially automating unfollows, runs against the spirit of Instagram's Terms of Use, which restrict collecting data through automated means. This tool is intended for managing **your own** account on a personal scale. Use it at your own risk and discretion.

**One-click unfollow & action-blocks.** The Unfollow button now unfollows the account directly through Instagram's `friendships/destroy` endpoint — no page visit needed. This is convenient but important to use carefully: rapid automated unfollowing is the single biggest trigger for Instagram **action-blocks** and, in extreme cases, account suspension. To reduce that risk the extension (a) asks you to acknowledge the risk once before enabling it, (b) does one account per click with a short cooldown so a stray double-click can't fire a burst, and (c) detects Instagram's anti-spam `feedback_required` response and stops with a warning. It is **not** a bulk unfollow bot by design. Best practice: unfollow in small batches (a few dozen a day at most), with breaks. If you ever see the action-block warning, stop for several hours.

**Rate limits.** Instagram rate-limits the list endpoints. The extension paces itself (randomized 1.5–3.5s between pages) and, if it gets a `429`, automatically waits 60 seconds and retries. Even so, very large accounts (tens of thousands) may take a long time or occasionally need a re-scan. If a scan errors out, wait a few minutes and try again.

**Accuracy.** Results are a snapshot from when you last scanned. Re-scan to refresh. "Following" counts shown here can differ slightly from the number on your profile because Instagram's profile counter includes some accounts (e.g. deactivated ones) that don't appear in the list.

**Fragility.** Because this relies on Instagram's private web endpoints (not a stable public API), Instagram can change them at any time and break the extension. If scans suddenly stop working, the endpoint or required headers likely changed.

**Privacy.** All data lives in `chrome.storage.local` on your machine. Nothing is uploaded anywhere. Removing the extension (or clearing its storage) deletes everything, including your whitelist.

### Fully ToS-compliant alternative
If you'd rather avoid the private endpoints entirely, Instagram lets you officially **Download Your Information** (Settings → Accounts Center → Your information and permissions → Download your information), choosing JSON format. That export contains `followers_1.json` and `following.json`. Comparing those two files gives the exact same "doesn't follow back" result with zero automation and no ToS gray area — it just isn't real-time. Ask if you'd like a small companion tool that does that comparison.

---

## License

Released under the [MIT License](LICENSE). Provided as-is, with no warranty. You are responsible for how you use it — automating actions on Instagram may violate Instagram's Terms of Use, and you use this tool at your own risk.

> **Disclaimer:** This project is not affiliated with, endorsed by, or sponsored by Instagram or Meta. "Instagram" is a trademark of Meta Platforms, Inc.

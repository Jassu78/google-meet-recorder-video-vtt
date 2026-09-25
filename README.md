<h1 align="center">Google Meet Recorder <code>(Video + .vtt)</code></h1>

<p align="center">
  <a href="https://github.com/Jassu78/google-meet-recorder-video-vtt/releases/latest">
    <img alt="Download latest release" src="https://img.shields.io/badge/Download-Latest_Release-4285F4?style=for-the-badge&logo=github&logoColor=white" />
  </a>
  <a href="https://github.com/Jassu78/google-meet-recorder-video-vtt/releases">
    <img alt="All releases" src="https://img.shields.io/badge/Releases-All_versions-5F6368?style=for-the-badge" />
  </a>
  <a href="https://github.com/Jassu78/google-meet-recorder-video-vtt/issues/new/choose">
    <img alt="Open an issue" src="https://img.shields.io/badge/Issues-Welcome-EA4335?style=for-the-badge" />
  </a>
  <a href="https://jassu78.github.io/google-meet-recorder-video-vtt/">
    <img alt="GitHub Pages" src="https://img.shields.io/badge/Site-GitHub_Pages-181717?style=for-the-badge&logo=githubpages&logoColor=white" />
  </a>
</p>

<p align="center">
  <img alt="Chrome Extension" src="https://img.shields.io/badge/Chrome-Extension-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" />
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-34A853?style=for-the-badge" />
  <img alt="webm" src="https://img.shields.io/badge/Video-.webm-EA4335?style=for-the-badge" />
  <img alt="vtt" src="https://img.shields.io/badge/Captions-.vtt-FBBC04?style=for-the-badge&logoColor=black" />
  <img alt="Local" src="https://img.shields.io/badge/Saves-Locally-5F6368?style=for-the-badge" />
</p>

<p align="center">
  <b>Record a Google Meet tab. Keep the video. Keep the captions. Keep it on your machine.</b><br />
  <a href="https://github.com/Jassu78/google-meet-recorder-video-vtt/releases/latest"><b>↓ Get the latest release zip</b></a>
  ·
  <a href="https://github.com/Jassu78/google-meet-recorder-video-vtt/releases">All releases</a>
</p>

A tiny Chrome extension that grabs the Meet call as a `.webm` and exports Meet’s live captions as a `.vtt` — straight into your Downloads folder. No cloud upload. No build step. Load the folder and go.

> [!TIP]
> **Fastest path:** open the [latest release](https://github.com/Jassu78/google-meet-recorder-video-vtt/releases/latest), download the zip, unzip it, then **Load unpacked** in `chrome://extensions`.

---

## At a glance

| Pill | Meaning |
| :---: | --- |
| `Chrome Extension` | Runs inside Chrome — not a separate desktop app |
| `Video + .vtt` | Tab recording + caption file in one stop |
| `Meet CC` | Transcript text comes from Google Meet captions |
| `Downloads/` | Files stay on your computer |

> [!NOTE]
> This extension does **not** invent speech-to-text. When you turn on Meet **Captions (CC)**, Google Meet shows caption text on the page. We scrape that DOM and save it as `.vtt`. The video/audio? That’s all you — captured locally with Chrome’s tab recorder.

> [!TIP]
> Want a usable transcript file? Turn **CC on before you hit Start**. No captions on screen → no `.vtt` at the end (video still saves).

---

## Install in 30 seconds

**Option A — release zip (easiest)**  
1. Download from the [latest release](https://github.com/Jassu78/google-meet-recorder-video-vtt/releases/latest)  
2. Unzip  
3. `chrome://extensions` → **Developer mode** → **Load unpacked** → select the unzipped folder  

**Option B — from this repo**  
1. Open `chrome://extensions`  
2. Flip on **Developer mode** (top right)  
3. Click **Load unpacked** → pick this repo folder  
4. Pin it to the toolbar if you like  

```
chrome://extensions  →  Developer mode  →  Load unpacked
```

---

## How to record

```
Meet tab  →  CC on  →  Start Recording  →  talk / listen  →  Stop
```

1. Join a call on `meet.google.com`
2. Enable **Captions**
3. Open the popup → **Start Recording**
4. Stay on the Meet tab (don’t wander off mid-take)
5. **Stop Recording** when you’re done

### What you should see while it runs

- Red **REC** badge on the extension icon
- Floating **Recording** chip on the Meet page
- Live caption peek in the popup when CC is flowing

> [!IMPORTANT]
> Muting yourself in Meet only removes **your** mic from the mix. Everyone else’s audio still lands in the `.webm`. That’s intentional.

---

## Outputs

| File | Looks like | What’s inside |
| --- | --- | --- |
| Video | `Meet-Recording-2026-….webm` | Tab video + audio |
| Captions | `Meet-Transcript-2026-….vtt` | Meet CC lines, timed |

Both drop into **Downloads**. Open the `.webm` in any modern player; open the `.vtt` in a text editor or load it beside the video in a player that supports subtitles.

---

## Package contents

Nothing fancy — seven files, zero compile:

```text
google-meet-recorder-video-vtt/
├── manifest.json      # extension brain
├── background.js      # start / stop / downloads
├── content.js         # Meet overlay + caption scrape
├── offscreen.html     # silent recorder page
├── offscreen.js       # MediaRecorder magic
├── popup.html         # the little control panel
└── popup.js
```

---

## Good to know

> [!WARNING]
> Meet’s caption UI can change. If Google reshuffles their DOM, video capture still works — caption scraping might need a tweak. That’s the brittle bit of living on someone else’s page.

| Topic | Detail |
| --- | --- |
| Chrome | 116+ |
| Site | `https://meet.google.com/*` |
| Permissions | tab capture, offscreen doc, downloads, storage |
| Build | none — load unpacked as-is |

---

## Issues

Something broken? Caption scrape miss a line? Idea for a small improvement?

[Open an issue](https://github.com/Jassu78/google-meet-recorder-video-vtt/issues/new/choose) — you’re welcome to. A short description of what you expected vs what happened (Chrome version + a rough Meet scenario) is plenty.

No formal template required. Be kind; that’s the whole bar.

---

## Contributing

PRs are welcome. This is a small extension — keep contributions small too.

1. Fork the repo and create a branch from `main`
2. Make a focused change (one problem / one idea)
3. Smoke-test it yourself:
   - Load unpacked in Chrome
   - Join a short Meet (or a solo room)
   - Start → talk with **CC on** → Stop
   - Confirm `.webm` downloads, and `.vtt` appears when captions were visible
4. Open a PR with a short note on **what** changed and **how** you tested it

That’s it. No CLA, no giant style guide. Match the existing code style, leave comments out unless something is truly non-obvious, and don’t expand scope into a rewrite.

> [!NOTE]
> Prefer fixing real Meet capture / caption bugs over drive-by refactors. If you’re unsure, [open an issue](https://github.com/Jassu78/google-meet-recorder-video-vtt/issues) first and we can align.

---

## Releases

Tagged versions ship a ready-to-load zip via GitHub Actions.

- **[Latest release](https://github.com/Jassu78/google-meet-recorder-video-vtt/releases/latest)** — download button lives here
- **[All releases](https://github.com/Jassu78/google-meet-recorder-video-vtt/releases)** — older builds if you need them

Unzip → Load unpacked. Same seven files as cloning the repo.

---

## License

MIT — fork it, break it, fix Meet’s next UI shuffle, share it.

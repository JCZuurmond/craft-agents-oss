# Capture: shot-scraper video — recording app walkthroughs, and using it in CI to evaluate apps

Source: https://shot-scraper.datasette.io/en/stable/video.html (captured 2026-07-06, `en/stable`)
Related: https://shot-scraper.datasette.io/en/stable/github-actions.html

## What it is

`shot-scraper video` records a WebM video of a scripted browser session from a
YAML "storyboard" file:

```bash
shot-scraper video storyboard.yml
shot-scraper video storyboard.yml -o demo.webm --mp4   # --mp4 also needs ffmpeg
```

A storyboard is a YAML mapping with an output filename, a starting URL (or an
opening scene) and a list of **scenes**. Each scene can open a page, wait for
content, run shell/Python hooks, perform browser actions and pause between
steps. Videos are recorded with Playwright, so everything runs headless —
which is exactly what makes it usable in CI.

Minimal example:

```yaml
output: demo.webm
url: https://shot-scraper.datasette.io/en/stable/

viewport:
  width: 1280
  height: 720

cursor: true                  # inject a visible cursor dot + click rings
wait_for: "text=Quick start"  # Playwright locator syntax

scenes:
- name: Documentation home
  do:
  - pause: 1

- name: Open installation docs
  do:
  - click: ".sidebar-tree a[href='installation.html']"
  - wait_for: 'h1:has-text("Installation")'
  - screenshot: installation.png
  - pause: 1

- name: Search the docs
  do:
  - click: "input.sidebar-search"
  - type:
      into: "input.sidebar-search"
      text: "authentication"
      delay_ms: 25
  - press:
      selector: "input.sidebar-search"
      key: Enter
  - wait_for: "text=Search Results"
  - pause: 2
```

## Storyboard reference (condensed)

Top-level keys:

| Key | Purpose |
|---|---|
| `output` | WebM filename (`-o`/`--output` overrides; `--mp4` also writes `.mp4` via ffmpeg) |
| `url` | Starting URL, bare domain, or path to a local HTML file. Omit only if the first scene has `open:` |
| `sh` / `python` | Setup commands that run **before** `server:` starts and before the browser opens (`sh:` first, then `python:`). Non-zero exit aborts the whole run with an error |
| `server` | Command (string or argv list) run **for the duration of the recording** — e.g. `python -m http.server 8000`. Auto-terminated when the command finishes unless `--leave-server` is passed |
| `viewport` | `width`/`height` mapping, defaults to 1280×720 |
| `cursor` | `true`, `false`, or mapping `{visible, clicks, color, size, click_size}` — Playwright videos don't show the system cursor, this injects one plus click rings |
| `wait` / `wait_for` / `wait_for_url` | Fixed pause, selector, or URL glob to wait for after the initial page loads, before scenes |
| `javascript` | JS run once in the initial page before scenes (prepare `localStorage`, theme, etc.) |
| `scenes` | Required list of scenes |

Scene keys: `name`, `open` (relative URLs resolve against the current page),
`wait_for`, `wait_for_url`, `sh`, `python`, and `do` (the action list). There
is no scene-level `javascript:` — put JS inside `do:` instead.

Actions inside a scene's `do:` list:

```yaml
- click: "selector"                                  # or {selector, button: left|right|middle, count}
- fill: {into: "selector", text: "value"}            # set a field immediately
- type: {into: "selector", text: "value", delay_ms: 25}
- press: Enter                                       # or {selector: "...", key: "ControlOrMeta+A"}
- scroll: 800                                        # or {x, y, duration} / {to: "selector", duration}
- pause: 1.5
- wait_for: ".loaded"
- wait_for_url: "**/finished"
- open: "installation.html"
- js: "document.body.dataset.demo = '1'"             # runs in the page; `javascript:` also accepted
- screenshot: output.png                             # or {output, selector, full_page}
- sh: "echo scene > scene.txt"                       # runs on the host; non-zero exit fails the run
- python: "open('scene.txt', 'w').write('ok')"
```

Command options mirror the other browser-based commands: `-b/--browser`
(chromium/firefox/webkit/chrome/chrome-beta), `--browser-arg`, `--user-agent`,
`-a/--auth` (JSON auth context), `--auth-username`/`--auth-password` (HTTP
Basic), `--timeout` (ms), `--reduced-motion`, `--log-console`, `--fail`,
`--skip`, `--bypass-csp`, `--silent`, `--leave-server`, `--mp4`.

## Using this in CI to evaluate apps

This is the interesting part: a storyboard run is simultaneously a **smoke
test** and an **evidence generator**. Everything needed is CI-friendly:

**The run itself asserts.** Failures exit non-zero, so the CI job fails:

- Every `wait_for:` / `wait_for_url:` is an implicit assertion — if the
  selector or URL never appears within `--timeout` milliseconds, the command
  fails. A storyboard that clicks through your app's core flows *is* an
  end-to-end test.
- Any `sh:` or `python:` hook (top-level, scene-level, or in `do:`) that exits
  non-zero aborts the run with an error — so you can drop real assertions in
  mid-storyboard (`sh: "curl -sf localhost:8000/healthz"`, or a Python block
  that checks a file the app should have written).
- `--fail` makes the run exit non-zero if a page returns an HTTP error.
- `--log-console` streams the app's `console.log()` output to stderr, so JS
  errors land in the CI log next to the failure.

**It boots the app for you.** The `server:` key runs your dev server for
exactly the duration of the recording and tears it down afterwards, with
`sh:`/`python:` available for build/seed steps first:

```yaml
output: walkthrough.webm
sh: |
  set -e
  bun run build:webui          # build the app under test
server: bun run serve:webui    # runs for the duration of the recording
url: http://localhost:3000/
wait_for: "text=Ready"
scenes:
- name: Core flow
  do:
  - click: "button#new-session"
  - wait_for: "text=New session created"
  - screenshot: new-session.png
  - pause: 1
```

**It produces reviewable evidence.** The WebM video (plus any `screenshot:`
stills taken along the way) is an artifact a human — or a vision model doing
automated UI evaluation — can review to judge what the app actually looked
like during the run, not just whether selectors matched. Upload it with
`actions/upload-artifact`; attach it to a PR for visual review of UI changes.

### GitHub Actions recipe

Adapted from the official workflow (which the docs note shot-scraper was
designed around), swapping the "commit screenshots back" step for artifact
upload since videos don't belong in git history:

```yaml
name: Record app walkthrough

on:
  pull_request:
  workflow_dispatch:

jobs:
  video:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-python@v5
      with:
        python-version: "3.12"
        cache: pip
    - name: Cache Playwright browsers
      uses: actions/cache@v4
      with:
        path: ~/.cache/ms-playwright/
        key: ${{ runner.os }}-playwright
    - name: Install shot-scraper
      run: |
        pip install shot-scraper
        shot-scraper install        # installs the Playwright browser
    - name: Record walkthrough (fails the job if any wait_for/hook fails)
      run: |
        shot-scraper video storyboard.yml --fail --log-console --timeout 30000
    - name: Upload video and screenshots
      if: always()                  # upload evidence even when the run failed
      uses: actions/upload-artifact@v4
      with:
        name: app-walkthrough
        path: |
          *.webm
          *.png
```

Notes for CI use:

- `shot-scraper install` downloads the Playwright browser; cache
  `~/.cache/ms-playwright/` to keep runs fast (pattern from the official docs).
- Skip `--mp4` in CI unless ffmpeg is installed — without ffmpeg the WebM is
  still written but the command exits non-zero.
- `--silent` quiets progress output; probably *don't* use it in CI, since scene
  names in the log show how far the run got before a failure.
- `--reduced-motion` emulates `prefers-reduced-motion`, useful for
  deterministic recordings of apps with animations.
- `-a/--auth` replays a saved authentication context (from
  `shot-scraper auth`) for apps behind a login.
- `if: always()` on the upload step matters: the video of a *failed* run is
  usually the most valuable artifact.

### Applicability to this repo

The `apps/webui` / `apps/viewer` targets here are the natural fit: a
storyboard that builds the webui, serves it via `server:`, walks the core
session flow with `wait_for:` assertions, and uploads the video from
`.github/workflows/` would give both a smoke test and a reviewable recording
per PR. (Not wired up in this change — this document is a capture/evaluation
note.)

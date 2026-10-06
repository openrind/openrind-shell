---
name: openrind-browser
description: Interact with the web using Openrind's 19 browser tools, inspect semantic DOM snapshots, and persist downloads and screenshots into /sandbox/work.
disable-model-invocation: false
user-invocable: true
allowed-tools: browser_capabilities, browser_start, browser_status, browser_tabs, browser_navigate, browser_snapshot, browser_click, browser_fill, browser_select, browser_press, browser_scroll, browser_screenshot, browser_upload_file, browser_downloads, browser_take_control, browser_resume, browser_close, browser_import_file, browser_save_artifact, BrowserStart, BrowserNavigate, BrowserSnapshot, BrowserClick, BrowserType, BrowserScroll, BrowserScreenshot, BrowserClose
---

# Openrind Browser Agent Guide

## Core Automation Workflow

1. **Check Capabilities & Start Session**:
   ```json
   // 1. Query available providers
   browser_capabilities({})

   // 2. Start a browser session
   browser_start({
     "provider": "local-chromium",
     "operationId": "op_start_1",
     "url": "https://example.com"
   })
   ```

2. **Inspect the Page (Semantic DOM Snapshot)**:
   ```json
   browser_snapshot({
     "sessionId": "<sessionId>",
     "sessionEpoch": <epoch>,
     "pageId": "<pageId>"
   })
   ```
   Inspect the returned tree of semantic nodes. Each actionable element has an assigned `ref` attribute (e.g. `br_xxx`).

3. **Perform Verified Actions**:
   ```json
   // Fill input field
   browser_fill({
     "sessionId": "<sessionId>",
     "sessionEpoch": <epoch>,
     "pageId": "<pageId>",
     "operationId": "op_fill_username",
     "ref": "br_123",
     "text": "testuser"
   })

   // Click submit button
   browser_click({
     "sessionId": "<sessionId>",
     "sessionEpoch": <epoch>,
     "pageId": "<pageId>",
     "operationId": "op_click_submit",
     "ref": "br_124"
   })
   ```

4. **Capture Screenshots & Save Artifacts**:
   ```json
   // Capture screenshot
   browser_screenshot({
     "sessionId": "<sessionId>",
     "sessionEpoch": <epoch>,
     "pageId": "<pageId>",
     "operationId": "op_shot_1"
   })

   // Save screenshot into workspace /sandbox/work
   browser_save_artifact({
     "sessionId": "<sessionId>",
     "sessionEpoch": <epoch>,
     "operationId": "op_save_shot_1",
     "artifactId": "<artifactId>",
     "destination": "reports/screenshot.png",
     "overwrite": true
   })
   ```

5. **Uploading Files into the Browser**:
   ```json
   // Stage file from workspace into browser service
   browser_import_file({
     "sessionId": "<sessionId>",
     "sessionEpoch": <epoch>,
     "operationId": "op_import_doc",
     "path": "data/sample.csv"
   })

   // Attach to file input element
   browser_upload_file({
     "sessionId": "<sessionId>",
     "sessionEpoch": <epoch>,
     "pageId": "<pageId>",
     "operationId": "op_upload_1",
     "ref": "br_file_input",
     "artifactId": "<stagedArtifactId>"
   })
   ```

6. **Close Session**:
   ```json
   browser_close({
     "sessionId": "<sessionId>",
     "sessionEpoch": <epoch>,
     "operationId": "op_close_1"
   })
   ```

## Reference and Epoch Rules

- Every page navigation or human handoff advances the session epoch and invalidates existing `ref` handles.
- If you receive `STALE_REF`, call `browser_snapshot` to obtain a fresh tree of references before retrying the action.
- Never hardcode reference handles across different tool calls without an intervening snapshot.

## Crucial Web Interaction & Task Rules

1. **Do NOT Bypass UI Interactions**:
   - When asked to visit a site and search for an item (e.g. "visit amazon.com and search for X"), **always start at the site homepage (`https://www.amazon.com`)**.
   - **Do NOT bypass searching by crafting direct search query URLs** (e.g. do NOT jump straight to `https://www.amazon.com/s?k=...`). Always locate the search input on the page, type the query using `browser_fill`, and submit it with `browser_press` (key: "Enter") or `browser_click`.
   - Complete the authentic sequence of actions requested by the user.

2. **Always Snapshot First**:
   - Call `browser_snapshot` immediately after navigating to a page.
   - The snapshot output begins with an interactive controls summary:
     ```text
     === Interactive Controls (in viewport) ===
     - [ref=br_xxx] textbox "Search Amazon" (bounds: x=240, y=15, w=800, h=40) [center: (640, 35)] [hit-testable, editable]
     - [ref=br_yyy] button "Go" (bounds: x=1045, y=15, w=45, h=40) [center: (1067, 35)] [hit-testable]
     ```
   - Target the exact `ref` of the control you need. Do not pass small `depth` values (omit `depth` or use default) so nested elements are never missed.

3. **Submitting Searches**:
   - After typing into a search textbox with `browser_fill`, submit the form by calling:
     ```json
     browser_press({
       "sessionId": "<sessionId>",
       "sessionEpoch": <epoch>,
       "pageId": "<pageId>",
       "operationId": "op_press_enter",
       "key": "Enter"
     })
     ```
   - Alternatively, call `browser_click` on the search button (`ref: "br_..."`).

4. **Dismissing Overlay Dialogs & Modals**:
   - If an interstitial popup appears (such as delivery address prompts, country shipping banners, or cookie notices), locate its "Dismiss" or "Close" button in the snapshot and click it before interacting with main content.

5. **Viewing Results & Scrolling**:
   - To inspect products or details below the fold, use `browser_scroll`:
     ```json
     browser_scroll({
       "sessionId": "<sessionId>",
       "sessionEpoch": <epoch>,
       "pageId": "<pageId>",
       "operationId": "op_scroll_down",
       "direction": "down",
       "distance": 800
     })
     ```
   - Follow each scroll with `browser_snapshot` to read the newly visible products, prices, and specifications.

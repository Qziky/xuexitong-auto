# Privacy

This extension runs in the user's browser. It has no project-operated account service, telemetry endpoint, or remote storage service.

## Data read from the learning platform

After login, and then on the scheduled overview refresh, the extension reads course summaries and ordinary homework lists. These refreshes do not read question text, chapter cards, or media and do not call an AI service. When the user opens a task and starts a task action, the extension reads the relevant page to identify its questions, choices, existing answers, and page state. Learning reads the selected course directory and selected resource pages only after the user starts learning.

The extension may use the browser's current authenticated session to read platform pages. Those platform reads stay between the browser and the learning platform. CAPTCHA, rate limiting, login expiry, account changes, or uncertain page ownership stop the workflow; the extension does not bypass these checks or automatically retry them.

## AI and OCR services

OCR runs locally using bundled code and language data. When the user starts model testing, visual transcription, or answer-reference generation, the extension sends the data needed for that selected operation to the configured OpenAI-compatible endpoint. This can include question text, choices, and images used for visual transcription or visual question answering. Batches with retained original images use the configured visual service; text-only batches use the answer service. The API key is sent to that endpoint for authentication. Requests omit browser credentials and reject redirects. The selected service's own privacy and retention terms apply to data it receives.

Opening a task page alone does not send a model request. The configured endpoint, model, and API key are selected by the user; there is no embedded project credential.

## Local storage and logs

Course and task state, preferences, queues, and execution history are stored in the browser's extension storage on the user's device. Provider settings and API keys are also stored in extension storage, which the extension restricts to trusted extension contexts. Temporary workspaces and preparation data use session storage. Developer run logs use local IndexedDB; ended runs are retained for up to 7 days and 100 runs, while an active run is retained until it ends. The logging code uses an explicit field allowlist and redacts credentials, signed URL parameters, cookies, image data, and font data.

The extension does not intentionally store raw page HTML, OCR images, or complete model responses in persistent logs. Browser storage may remain while the extension is installed; users can clear the extension's data through browser controls. Do not share exported logs without reviewing them first.

Question images that cannot be reliably transcribed are retained in a separate local IndexedDB cache for later visual question answering and preview/download in the question details. References bind each image to its account, task, page fingerprint, and question image identifier. The cache has a 64 MiB limit and a seven-day validity period; reads and writes clean up expired records and evict the least recently used records when necessary. Image bytes and resource URLs do not enter persisted preparation metadata, persistent logs, diagnostics, or TXT exports. Preparing images does not itself generate or submit answers. If retained image material is missing or expired, the extension requires recognition again rather than sending image placeholders alone to a model.

## Permissions

The extension uses browser storage, alarms, notifications, the side panel, an offscreen document, scripting, tabs, and web navigation to provide its features. Its default host access covers Chaoxing domains and the preconfigured model endpoint. Optional host access supports a model endpoint chosen by the user and local loopback development services; optional access is requested when needed.

## User choices

The user starts recognition, reference generation, filling, saving, and submission as separate actions. A generated answer is only a proposal. The user is responsible for checking the content, applicable platform rules, and the privacy terms of any configured model service before proceeding.

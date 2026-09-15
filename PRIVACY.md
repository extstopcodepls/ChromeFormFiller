# Privacy notes

Chrome Form Filler has no telemetry, cloud synchronization, analytics, or external data transfer.

The extension only observes forms on origins the user explicitly enables. While the vault is unlocked, it may temporarily capture eligible form values to support an explicit save action or a submission-attempt review. Password, payment, one-time-code, hidden, disabled, and read-only controls are excluded by default.

Saved fillings are encrypted before they are written to `chrome.storage.local`. The passphrase is not stored, and there is no recovery mechanism. Temporary submission drafts are encrypted in session storage and expire after 15 minutes. Locking clears the session key and drafts.

For file controls, the extension stores no file bytes. A reusable path is only used if Chrome exposes one for a selected local file; reusing it makes that file’s current contents available to the page immediately when selected.

The extension never intentionally submits forms and does not call `preventDefault()` for submission detection. A page can still navigate or make requests in response to ordinary input and submission events.

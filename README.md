# Chrome Form Filler

A Manifest V3 Chrome extension for saving named fillings for individual HTML forms and replaying a chosen filling through Chrome DevTools Protocol DOM updates and events.

## Development

```text
pnpm install
pnpm build
pnpm build:dev
pnpm test
```

`pnpm build` creates the minified production bundle. Use `pnpm build:dev` for a one-shot unminified bundle, or `pnpm dev` to keep an unminified bundle updated in watch mode. Both write to `dist` for loading as an unpacked extension.

Load the generated `dist` directory with **chrome://extensions → Developer mode → Load unpacked**. The extension targets desktop Chrome 120+ on Windows. It is intentionally limited to top-level ordinary HTML forms. Passwords, payment credentials, OTP-like controls, shadow DOM, iframes, custom widgets, and contenteditable editors are excluded in v1.

The first vault unlock creates a local vault. There is no passphrase recovery. Saved names, form identities, values, file metadata, and per-filling wait settings are encrypted locally; no plaintext values or file bytes are uploaded. File selections without a reusable local path are surfaced for manual reselection. A saved filling can configure a default wait in milliseconds after each included field is set and verified, with optional per-field overrides.

## Debugging filling

Open the extension popup and enable **Enable debug logging**. The target page's DevTools Console shows `[Form Filler]` form discovery, every control's eligibility decision, and each independently serialized `id`, `name`, `label`, and `position` lookup key. Its `fill.requested` and `fill.completed` events include the complete target-form identity and value-free intended/current/per-result field metadata. The extension service worker's DevTools console shows `[Form Filler][worker]` decisions for every saved-form candidate. Each field trace records all independent key attempts, their compatible candidate counts, ambiguity, and the selected strategy. `[Form Filler][replay] field.match` reports the same lookup attempts against the live DOM; open it from **chrome://extensions → Form Filler → Service worker → Inspect**. The inline fill result also exposes **Field details** for every manual, missing, or failed control. Debug output intentionally excludes field values and local file paths.

## Verification

The repository includes unit coverage for exact form matching and the AES-GCM/PBKDF2 vault envelope. Native replay and Chrome permission/debugger behavior require a headed Windows Chrome run with a fixture page.

# Heldnote — Brand Implementation Brief

- Date locked: 2026-08-06
- Status: Locked — name, domain, tagline, and visual direction should remain stable while assets are produced.

## 1. Locked Brand Decisions

- Brand name: **Heldnote**
- Canonical domain: **heldnote.app**
- Brand endorsement: Heldnote by OFCode
- Product category: Recovery-first, local-first browser notepad
- Primary tagline: Write freely. Return anytime.
- Product descriptor: Local-first notes with version history
- Core promise: Your writing remains within reach.
- Visual direction: Quiet Assurance

## 2. Primary Logo Direction

Concept: **Continuous Return** — a written note, uninterrupted continuity, and a return to an earlier state, drawn as one continuous line forming a simplified lowercase **h**, transitioning into a note shape, finishing with a subtle return curve. Stable and calm, not fast or energetic.

Wordmark: lowercase `heldnote`, medium weight, slightly softened corners, wide letter spacing for small sizes, no exaggerated geometric construction, no handwritten styling.

Lockups: Primary horizontal `[symbol] heldnote`; Compact `[symbol]`; Endorsed `heldnote` / `by OFCode` (endorsement stays secondary).

## 3. App Icon and Favicon

Same continuous-return symbol. Square canvas, dark graphite background, soft-paper or muted-sage symbol, generous internal spacing, no text inside, no gradients in the primary version, recognizable at 16×16px.

Required formats: browser favicon, PWA icon, Apple touch icon, social profile image, repository avatar, monochrome mark, light-background variant, dark-background variant.

Avoid: floppy disks, clouds, shields, padlocks, sync arrows, checkmarks as the main identity, document icons with excessive detail.

## 4. Final Color System

Core neutrals:

| Token | Purpose | Value |
|---|---|---|
| Ink 950 | Main dark background | `#0E1116` |
| Ink 900 | Sidebar and panels | `#171B22` |
| Ink 800 | Elevated surfaces | `#202630` |
| Paper 100 | Primary dark-theme text | `#F2F0E8` |
| Mist 400 | Secondary text | `#9CA6B4` |
| Stone 300 | Light-theme borders | `#D7D4CC` |
| Paper 50 | Light-theme background | `#F6F4EE` |
| Graphite 900 | Primary light-theme text | `#20242A` |

Functional colors:

| Token | Purpose | Value |
|---|---|---|
| Sage 500 | Successfully stored revision | `#78A98D` |
| Blue 500 | Browser-retention information | `#7295BA` |
| Cyan 500 | Keyboard focus and active controls | `#73B8C8` |
| Amber 500 | Storage warning or degraded state | `#D4A65A` |
| Coral 500 | Save failure or destructive action | `#D87970` |

Usage rule: Sage communicates only that a completed application transaction has been stored — never that the browser guarantees permanent retention. Browser-retention state always uses a separate label, icon, and color.

## 5. Typography

- Interface: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- Editor: `ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace`

| Element | Weight | Size |
|---|---:|---:|
| Marketing headline | 600 | 48–64px |
| Product name | 600 | 20–24px |
| Page heading | 600 | 24–32px |
| Panel heading | 600 | 14–16px |
| Interface body | 400 | 14–16px |
| Editor text | 400 | 16–18px |
| Status text | 500 | 12–13px |
| Metadata | 400 | 12–13px |

## 6. Interface Identity

Left sidebar: symbol, search, new note, pinned notes, recent notes, trash, import/export access.
Main editor: note title, plain-text writing surface, quiet metadata, no permanent toolbar unless required.
Version panel: closed by default, timestamps, short preview, compare/preview action, restore action.
Bottom status area: Revision (`Saved · 08:24`) and Browser retention (`Best effort`) as two separate lines, plus word count, character count, storage warnings, read-only status.

## 7. Interaction Style

- Motion: 120–180ms control transitions, 180–240ms panel transitions, subtle opacity/position only, no bouncing, no confetti, no animated save celebration, respect `prefers-reduced-motion`.
- Corners: controls 6px, panels 8px, dialogs 10px, status pills fully rounded only when semantically useful.
- Shadows: minimal — tonal separation and borders over floating-card effects.
- Icons: simple, outlined, consistent stroke width, always labeled for restore/export/import/storage condition/destructive operations.

## 8. Product Language

Saving: "Saving…" / "Saved locally · 08:24" / "Not saved — memory only" / "Unsaved draft recovered"

Browser retention: "Browser retention: Persistent" / "Browser retention: Best effort" / "Browser retention: Session only" / "Browser retention: Unknown"

Version history: panel title "Version history"; action "Preview version"; restore confirm "Restore this version? The current text will remain available as an earlier version."; success "Earlier version restored"

Trash: "Move to trash" / "Restore note" / "Delete permanently" / confirm "Delete this note and all of its version history from this browser? This action cannot be undone."

## 9. Landing Page Structure

Nav: Product · How it works · Data and storage · Open source · Launch app

Hero label: "Local-first browser notepad". Headline: "Write freely. Return anytime." Supporting: "Heldnote saves continuously as you type and keeps earlier versions of every note. No account, manual save action, or setup required." Primary CTA "Start writing", secondary "How saving works".

Trust indicators: No account · Saved in this browser · Version history · Reversible deletion · Export anytime.

Sections: 1) A place for unfinished thinking 2) Saving without ceremony 3) Every note has a way back 4) Local and transparent 5) Portable by design. Closing CTA: "Keep the next thought within reach." / "Start writing".

## 10. Domain and Deployment Rules

Production: `https://heldnote.app`. Redirects: `www.heldnote.app` → `heldnote.app`, HTTP → HTTPS, any future secondary domain → `heldnote.app`. Never launch to real users on a temporary hostname before the permanent domain, since IndexedDB storage is origin-specific and a later hostname change orphans existing notes.

Required pre-launch actions: configure canonical domain; enable HTTPS; set canonical URL; configure `www` redirection; add a web app manifest; add final favicon/app icons; confirm IndexedDB behavior on the production origin; test export/import before public launch; test private-browsing and restricted-storage conditions; document browser-storage limitations clearly.

## 11. Brand Asset Package (deliverables, not yet produced)

Primary logo, horizontal wordmark, app icon, favicon set, monochrome logo, light/dark logo variants, color tokens, typography rules, iconography rules, UI component samples, landing-page mockup, social sharing image, GitHub repository banner, product screenshot template, compact brand guidelines document.

## 12. Recommended Execution Order

- Stage A — Identity: draw the continuous-return symbol, develop the wordmark, test at favicon size, create light/dark/monochrome variants.
- Stage B — Product system: convert the palette into CSS variables, apply typography/spacing, design status indicators, design editor/sidebar/version panel, verify keyboard focus and contrast. (This stage is what `2026-08-06-heldnote-v1-implementation.md` Task 16 implements in code.)
- Stage C — Website: build the heldnote.app landing page, product explanation, honest local-storage messaging, connect primary CTA to the app.
- Stage D — Launch preparation: browser/storage testing, screenshots, repository branding, privacy/storage explanations, name/trademark screening, launch announcement.

## 13. Immediate Creative Decision

First visual concept: **Continuous Return** — lowercase **h** as one uninterrupted line, transitioning into a subtle note outline, returning inward. Default treatment: Ink 950 background, Paper 100 wordmark, Sage 500 symbol accent, lowercase `heldnote`, no gradient, no slogan inside the logo lockup.

---

*Stage A (logo/icon graphic design) and Stage C (marketing landing page) are separate design deliverables from the engineering implementation plan — they are not produced by writing code in this repo's `store.js`/`db.js`/UI modules. Stage B's concrete, code-relevant specifics (color tokens, typography, corner radii, motion timing, exact product copy, favicon/manifest checklist) are incorporated into `docs/superpowers/plans/2026-08-06-heldnote-v1-implementation.md`.*

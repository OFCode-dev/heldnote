# Heldnote

**Your thoughts, held onto.** / **Düşüncelerine yer aç.**

Heldnote gives unfinished thoughts a quiet place to live. It should be easier
to begin writing, change your mind and revisit an earlier version than to set
up an account or organize a workspace.

## Product principles

- Protect the writing before polishing the interface. Preserve drafts,
  history, exports and origin continuity through every change.
- Explain saving, retention, synchronization and independent backup as
  different things. Never advertise “nothing can ever be lost”.
- Keep the first writing action free of registration. Google Drive is a choice.
- Be specific about limits: browser eviction, private sessions, finite history,
  token expiry and offline loading.
- Keep user writing out of public examples, SEO content, analytics and ads.

## Identity

The held fold is an H with two upright strokes and a page-corner accent.
The H gives a compact, recognizable icon; the fold suggests a previous page
that remains within reach. Primary source: logo.svg; reverse: logo-reverse.svg.
Exported PNG icons and social-card.png are checked in, so deployment needs no
asset build step. Source Serif 4 is self-hosted; navigation uses system fonts.

| Role | Color |
| --- | --- |
| Paper | #F4F1E9 |
| Forest | #26483D |
| Text | #263C34 |
| Terracotta text | #A54D34 |
| Fold accent | #C4694B |

The voice is calm, practical and direct. Use “your notes live in this browser”
instead of vague claims about privacy. Show the product, not invented customer
counts, reviews or badges. English and Turkish are first-class landing
languages; link untranslated guides and policies with an English label in TR.

## Discovery

Public pages answer concrete questions about browser notes, history, backup
and optional sync. HTML carries the full content before JavaScript. Titles,
canonicals, language alternates, social cards and structured data describe
what is actually visible. Indexing, rankings and AI citations are outcomes
to measure, not guarantees or certifications.

## Commercial direction

No ad integration is active. Start with clearly labelled, first-party static
sponsorships if a partner is agreed; these need no third-party script. Never
invent a sponsor or publisher ID.

Programmatic ads such as AdSense need a separate public-content origin that
does not hold the IndexedDB notes or cached Drive token. A different path on
heldnote.app is not an isolation boundary. Keep the existing editor origin;
changing it would need an explicit data migration.

Before activating a provider, agree the origin and placement, verify publisher
content eligibility, obtain actual account/slot identifiers, configure the
applicable consent flow, publish accurate privacy disclosures and ads.txt
entries where required, and review the mobile writing experience. Provider,
DNS and production changes require the owner's approval.

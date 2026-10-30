# Hosted Space UI

This is the online client for the approved 2026-10-25 Space plan. Every device
authenticates directly with `/api/space`; it does not mount a desktop owner or
download a model. The local launcher, Control and Display routes remain separate.

The UI consumes the existing `components/hark` package from
`ECdison6227/rea-ui-library@26ac2724f29b4ee46962146fed2b6d545bf62180`.
Its seven font files, original SVG paths, continuous-corner geometry, light/dark
material roles and frozen sky are reused. The implementation reads the source
`DESIGN_SPEC.md` and `ADAPTATION_GUIDE.md` from the local Hark library.

Target mapping (D): Hark project navigation selects a server Space; the 512px
composer and source message materials display task feedback and references;
regular surfaces host the existing Vivic card renderers. Desktop uses persisted
coordinates and fixed-card constraints. Mobile presents the same records in one
vertical list without writing desktop coordinates. Auth, device codes, reminders,
upload receipts and account settings are Vivic business adaptations. These are
not claims that the original Hark account/product workflows were fully verified;
the source package remains partial.

Passwords and model keys are controlled fields and same-origin request bodies.
Browser storage holds user drafts, appearance and recovery receipts. New business
commands persist their schema-validated request ID, original version and body
before sending; auth/model credentials never use that ledger. Unknown results are
queried under the original ID. A confirmed missing receipt exposes an explicit
retry of that same ID/body/version, including after refresh; nothing auto-reposts.
Older opaque receipts remain query-only. Version conflicts keep the original query
evidence and drafts without automatically rebasing or creating a new request.
Draft revisions/fingerprints and reminder durations protect later user edits.
If the browser cannot persist a command's recovery record, that command is not
sent. This recovery does not extend to opaque historical requests or model-task
payload replay; those remain on their existing status-query paths.

Cards, charts, reading panels and voice load on demand. Basic cards reuse the
existing note/todo/countdown views; other kinds use the existing lazy VivicCard.
`hostedAssets` validates original bytes before reading/downloading, uses the
existing PDF/Markdown reader and keeps model questions behind an explicit action.
Recording, recognition and TTS playback require user actions; recording stops at
59 seconds, and recognition text is reviewed before appending to the draft.

Implementation alone does not establish browser, Android SAF, audio quality,
cross-device or visual acceptance. The root task runs those checks serially and
records the actual boundaries separately.

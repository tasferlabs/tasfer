# Launch Checklist

Use this checklist for the first public release of the Cypher app and the
`@cypherkit/*` packages. Every checked item should have evidence: a test run,
reviewed URL, build artifact, issue, or named reviewer.

## Release definition

- [ ] Decide exactly what is launching: web app, signaling relay, desktop apps,
      mobile apps, npm packages, documentation, or a staged subset.
- [ ] Choose the release date, release owner, and go/no-go decision time.
- [ ] Assign an owner to every section below.
- [ ] Define supported browsers, operating systems, mobile versions, and device
      classes.
- [ ] Define which features are production-ready, beta, experimental, or
      intentionally excluded.
- [ ] Freeze release scope. Move non-blocking work to a post-launch list.
- [ ] Agree on launch blockers and rollback criteria before final testing.

## Known repository issues to resolve

- [ ] Correct the root README setup. There is no root `package.json`, so
      root-level `npm install` is not a valid installation step.
- [ ] Correct stale README architecture paths that still place the editor and
      CRDT under `apps/web`; the reusable engine now lives in `packages/editor`.
- [ ] Reconcile product versions. The app, desktop wrapper, relay, site, and npm
      packages currently use unrelated placeholder or development versions.
- [ ] Verify all platform and privacy claims against the implementation,
      especially relay fallback, encryption, telemetry, supported platforms,
      and where data may transit.

## Product acceptance

### Core editing

- [ ] Create, rename, open, close, and delete pages and spaces.
- [ ] Test paragraphs, headings, lists, to-do items, images, dividers, block
      math, inline math, links, and every enabled node or mark.
- [ ] Test typing, selection, navigation, deletion, copy, cut, paste, undo, and
      redo with keyboard, mouse, touch, and trackpad where applicable.
- [ ] Test empty documents, large documents, long lines, large images, deeply
      nested lists, and rapid edits.
- [ ] Test IME composition with representative CJK input methods.
- [ ] Test Arabic, Hebrew, mixed-direction text, punctuation, and selection.
- [ ] Test font loading, fallback fonts, zoom, resizing, and high-DPI displays.
- [ ] Test slash menus, context menus, overlays, popovers, toolbars, and find.
- [ ] Test multiple editor instances on the same page for state leakage.
- [ ] Verify no supported action causes content loss, duplication, corruption,
      an uncaught exception, or an unrecoverable blank screen.

### Persistence and recovery

- [ ] Confirm documents survive reload, browser restart, app restart, offline
      use, and device sleep.
- [ ] Confirm opening existing local data does not silently discard operations,
      unknown content, marks, assets, or metadata.
- [ ] Test snapshots and operation-log rebuilds from realistic data volumes.
- [ ] Test storage quota exhaustion, write failure, corrupt local data, and
      unavailable filesystem/database behavior.
- [ ] Verify deletion behavior and document what is recoverable.
- [ ] Verify image and asset persistence, deduplication, missing-asset handling,
      and lazy retrieval.
- [ ] Export important test documents and verify their output independently.

### Collaboration

- [ ] Test first-time identity creation and pairing.
- [ ] Test two and three or more peers editing simultaneously.
- [ ] Test concurrent insertion, deletion, formatting, block movement, and
      offline edits followed by reconnection.
- [ ] Test awareness, cursors, selections, peer joins, peer leaves, and reconnects.
- [ ] Test large catch-up syncs and slow, lossy, or interrupted networks.
- [ ] Test direct WebRTC connections and every supported relay/fallback path.
- [ ] Verify peers converge after randomized and adversarial edit sequences.
- [ ] Verify incompatible or malformed messages fail safely.
- [ ] Verify content and assets are never exposed to infrastructure contrary to
      the published privacy and encryption claims.

### Accessibility and usability

- [ ] Complete keyboard-only flows for all DOM-based controls.
- [ ] Check focus order, focus visibility, labels, roles, and screen-reader
      announcements.
- [ ] Review the canvas editor's accessibility limitations and publish them
      clearly rather than implying unsupported accessibility.
- [ ] Test light and dark themes, reduced motion, text scaling, contrast, and
      common color-vision deficiencies.
- [ ] Run first-use sessions with people who have not seen the product.
- [ ] Confirm onboarding, pairing, errors, empty states, and recovery paths are
      understandable without developer assistance.

## Platform testing

### Web and PWA

- [ ] Test every supported browser in normal and private browsing modes.
- [ ] Test installation, update, offline launch, service-worker refresh, and
      recovery from a stale or failed deployment.
- [ ] Test OPFS/SQLite behavior on every supported browser.
- [ ] Verify production routing for the app, site, documentation, privacy page,
      assets, and `/page` links.
- [ ] Verify cache headers, content security policy, HTTPS, and security headers.

### Desktop

- [ ] Build clean macOS, Windows, and Linux artifacts from a tagged commit.
- [ ] Install, launch, upgrade, uninstall, and reinstall each artifact.
- [ ] Verify macOS signing, hardened runtime, entitlements, and notarization.
- [ ] Verify Windows signing, installer behavior, and SmartScreen experience.
- [ ] Verify Linux AppImage, Debian package, and pacman package as supported.
- [ ] Test native filesystem, SQLite, cryptography, clipboard, links, and updates.
- [ ] Confirm packaged desktop builds include the correct web production bundle.

### iOS and Android

- [ ] Run Capacitor sync from a clean web production build.
- [ ] Test physical phones and tablets, not only simulators.
- [ ] Test first launch, backgrounding, resume, rotation, keyboard resizing,
      safe areas, links, clipboard, files, haptics, and permissions.
- [ ] Verify app identifiers, icons, splash screens, version/build numbers, and
      store metadata.
- [ ] Complete App Store and Play Store privacy/data-safety declarations based on
      observed behavior.
- [ ] Test upgrades without loss of local documents or identity.

## Setup and deployment

- [ ] Follow every README and documentation setup path on a clean machine.
- [ ] Verify the exact supported Node.js and npm versions.
- [ ] Run `npm install` independently in every shipped app and package.
- [ ] Confirm every required environment variable is documented with safe
      examples and production expectations.
- [ ] Verify local web, site, relay, desktop, iOS, and Android setup instructions.
- [ ] Verify production domain, DNS, TLS, CDN, routing, and environment values.
- [ ] Deploy the signaling relay from a clean environment and perform a live
      cross-network connection test.
- [ ] Document backup, rollback, incident response, and service ownership.
- [ ] Confirm production secrets are absent from source, artifacts, logs, and
      client bundles.
- [ ] Confirm launch infrastructure has monitoring appropriate to its stated
      privacy model.

## Public API and npm packages

- [ ] Decide which `@cypherkit/*` packages and subpath exports are supported.
- [ ] Review every public export for naming, consistency, ownership, lifecycle,
      error behavior, and unnecessary implementation leakage.
- [ ] Review the newly added API as a complete workflow, not only individual
      functions: create, configure, mount, mutate, observe, synchronize, persist,
      destroy, and recover from errors.
- [ ] Remove accidental exports and expose missing types intentionally.
- [ ] Test multiple independent editor and document instances.
- [ ] Verify browser, React, bundler, SSR, ESM, and CommonJS behavior where each
      package claims support.
- [ ] Build every package from a clean checkout.
- [ ] Run `npm pack --dry-run` and inspect included files, licenses, notices,
      declarations, source maps, and package size.
- [ ] Install packed tarballs into clean example projects; do not validate only
      through repository path aliases.
- [ ] Verify package dependency and peer-dependency ranges.
- [ ] Replace placeholder `0.0.0` versions and align inter-package versions.
- [ ] Confirm package descriptions, keywords, repository links, READMEs,
      changelogs, and provenance metadata.
- [ ] Confirm MIT license files and third-party notices ship in every package
      that requires them.
- [ ] Test collaboration providers independently and in representative
      compositions.
- [ ] Document stability guarantees, experimental APIs, and breaking-change
      policy.

## Documentation and examples

- [ ] Test the installation guide by copying commands exactly as written.
- [ ] Test quickstart and first-editor examples in clean projects.
- [ ] Compile every code sample and verify its rendered result.
- [ ] Review concepts, editor API, command API, schema API, React API, custom
      nodes, theming, and collaboration documentation against source exports.
- [ ] Verify app getting-started, self-hosting, sync-relay, privacy, and
      troubleshooting guides.
- [ ] Test all examples against packed npm artifacts.
- [ ] Check internal and external links, navigation, headings, code blocks, and
      mobile documentation layout.
- [ ] Clearly separate current behavior from plans, experiments, and archived
      internal designs.
- [ ] Add a migration guide if any pre-release users or integrations exist.

## Marketing and product prose

- [ ] Read every sentence on the home page, README, app stores, package pages,
      documentation landing pages, privacy page, support page, and release post.
- [ ] Verify each feature claim by reproducing it in a release build.
- [ ] Remove absolute claims that cannot be demonstrated.
- [ ] Review “local-first,” “peer-to-peer,” “end-to-end encrypted,” “no cloud,”
      “no servers,” “no telemetry,” “no cookies,” and “cross-platform” language
      with precise definitions and exceptions.
- [ ] Ensure direct WebRTC and relay/fallback descriptions match deployed network
      behavior.
- [ ] Ensure supported nodes, marks, languages, platforms, and accessibility
      claims match what was actually tested.
- [ ] Check product naming, capitalization, terminology, URLs, screenshots,
      videos, download links, and calls to action for consistency.
- [ ] Review English for clarity and have every published translation reviewed
      by a fluent speaker.
- [ ] Confirm screenshots and recordings show the release build and contain no
      private data or misleading mock behavior.

## Security, privacy, and legal

- [ ] Threat-model identity, pairing, signaling, WebRTC, relay fallback, local
      storage, assets, imports, links, desktop IPC, and native bridges.
- [ ] Review cryptographic protocol use and key storage with a qualified reviewer.
- [ ] Test malformed network messages, untrusted document content, hostile URLs,
      oversized payloads, and denial-of-service boundaries.
- [ ] Run dependency and secret scans and triage every finding.
- [ ] Verify the security reporting channel works and has an accountable owner.
- [ ] Verify privacy prose against actual network requests, storage, logs,
      analytics, crash reporting, and third-party services.
- [ ] Review the privacy policy with the actual launch jurisdictions and store
      requirements in mind.
- [ ] Confirm AGPL, MIT, CLA, commercial licensing, source-offer, copyright, and
      third-party attribution requirements with legal counsel where necessary.
- [ ] Regenerate and inspect `THIRD-PARTY-LICENSES.txt` in production builds.

## Performance and reliability

- [ ] Set measurable launch budgets for startup, typing latency, render time,
      memory, bundle size, sync latency, and storage growth.
- [ ] Measure small, typical, large, and pathological documents.
- [ ] Test long-running editing sessions and repeated mount/unmount cycles.
- [ ] Test network churn, relay restarts, offline duration, and reconnection.
- [ ] Profile memory leaks, unbounded operation-log growth, canvas work, and
      excessive persistence or network traffic.
- [ ] Verify failures produce actionable user messages without exposing secrets.

## Required automated checks

- [ ] `packages/editor`: build, tests, lint, and format check.
- [ ] `packages/tex`: build, tests, render check, lint, and format check.
- [ ] `packages/react`: build.
- [ ] Every `packages/provider-*` package: build.
- [ ] `apps/web`: production build.
- [ ] `apps/site`: production build.
- [ ] `apps/desktop`: build and package.
- [ ] Add CI coverage for all release-critical checks above.
- [ ] Run the full suite from the exact release commit with a clean dependency
      installation.

## Release candidate

- [ ] Create a release-candidate tag from a clean working tree.
- [ ] Build all artifacts from that tag in the release environment.
- [ ] Record checksums, versions, commit SHA, build environment, and signing
      identities.
- [ ] Perform a final smoke test using deployed production services and signed
      artifacts.
- [ ] Conduct a bug triage and explicitly accept or block every open launch issue.
- [ ] Confirm rollback artifacts and instructions are ready.
- [ ] Obtain product, engineering, security/privacy, documentation, and release
      owner sign-off.

## Launch and immediate follow-up

- [ ] Publish packages and artifacts in the planned dependency order.
- [ ] Deploy the relay, web app, site, and documentation.
- [ ] Verify downloads, npm installation, production links, and live pairing.
- [ ] Publish release notes with known limitations and support channels.
- [ ] Monitor errors, availability, package installation reports, and user
      feedback without violating published privacy commitments.
- [ ] Assign owners and deadlines to launch regressions.
- [ ] Run the rollback plan if a launch blocker is discovered.
- [ ] Complete a launch retrospective and convert deferred items into tracked
      post-launch work.

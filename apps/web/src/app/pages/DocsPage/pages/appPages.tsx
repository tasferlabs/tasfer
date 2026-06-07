/* Cypher app documentation pages — ported from docs-app.jsx.
   The page-level pager and article header are supplied by the shell. */
import { Icons } from "../docsIcons";
import {
  A,
  Callout,
  Card,
  CardGrid,
  Code,
  PropsTable,
  Step,
  Steps,
} from "../docsComponents";

const REPO = "https://github.com/hamza512b/cypher";

export function AppGettingStarted() {
  return (
    <>
      <p className="dx-lede">
        Cypher is a local-first, end-to-end encrypted markdown editor. Your files
        live on your disk, your keys never leave your device, and sync is
        peer-to-peer. <strong>There is no account to create — you start by opening
        the app.</strong>
      </p>

      <h2 id="install">Install</h2>
      <p>Cypher runs as a desktop app and as a local web build. Pick whichever fits your machine:</p>
      <CardGrid>
        <Card to="app/getting-started" icon={<Icons.Download />} title="Desktop (macOS / Windows / Linux)"
          desc="Signed binaries on the releases page. Auto-updates can be turned off in Settings." />
        <Card to="app/getting-started" icon={<Icons.Terminal />} title="Run it yourself"
          desc="Clone the GPL-3.0 repo and run a local build. The relay is a separate, optional service." />
      </CardGrid>
      <p>To build from source:</p>
      <Code lang="bash" code={`
git clone https://github.com/hamza512b/cypher
cd cypher
pnpm install
pnpm dev          # opens the app at http://localhost:4000
`} />

      <h2 id="first-doc">Your first document</h2>
      <Steps>
        <Step title="Pick a vault folder">
          <p>On first launch, Cypher asks where to keep your files. Choose any folder — your notes are written there as plain <code>.md</code> files you can open in any editor, today or in twenty years.</p>
        </Step>
        <Step title="Write">
          <p>Markdown shortcuts work as you type: <code>#</code> for headings, <code>**bold**</code>, <code>&gt;</code> for quotes, <code>- [ ]</code> for tasks. Everything saves to disk instantly — there is no "save" button and no spinner reporting to a server.</p>
        </Step>
        <Step title="Back it up like any folder">
          <p>Because your vault is just files, your existing backup tools already cover it. Copy it, zip it, put it in a git repo, sync it with rsync. Cypher does not own a single byte you write.</p>
        </Step>
      </Steps>

      <Callout kind="note" title="No telemetry, ever.">
        Cypher ships with no analytics, no crash reporting that phones home, and no
        account system. The first run does not contact a network at all. See{" "}
        <A href="/docs/app/privacy">Privacy &amp; data</A> for the complete list of
        what the app does and does not collect.
      </Callout>

      <h2 id="next">Next steps</h2>
      <CardGrid>
        <Card to="app/sync-relay" icon={<Icons.Link />} title="Sync across devices"
          desc="Turn on peer-to-peer sync and pair a second device in under a minute." />
        <Card to="app/privacy" icon={<Icons.Shield />} title="Privacy & data"
          desc="Exactly what stays on your disk and what (nothing) leaves it." />
      </CardGrid>
    </>
  );
}

export function AppSyncRelay() {
  return (
    <>
      <p className="dx-lede">
        Sync is off by default. When you turn it on, your devices talk
        <strong> directly, peer-to-peer, encrypted with keys that never leave your
        hardware.</strong> A relay exists only to introduce devices that can't see
        each other directly — and it can't read a thing.
      </p>

      <h2 id="how">How sync works</h2>
      <p>Three stages, in plain terms:</p>
      <ul>
        <li><strong>Introduce.</strong> A relay tells your two devices how to reach each other. It does not authenticate them and learns nothing else.</li>
        <li><strong>Direct.</strong> Your devices negotiate an encrypted peer-to-peer channel and talk to each other with no third party in the path.</li>
        <li><strong>Fallback.</strong> If a direct path can't be made (strict NAT, locked-down network), the relay forwards encrypted bytes it cannot decrypt. Still no accounts, still no logs.</li>
      </ul>
      <Callout kind="note" title="See it move.">
        The relay model is animated on the <A href="/docs">documentation home</A> and
        the <A href={REPO}>project landing page</A> — introduce, direct, fallback.
      </Callout>

      <h2 id="enable">Turn on sync</h2>
      <Steps>
        <Step title="Open Settings → Sync">
          <p>Toggle <strong>Enable sync</strong>. Cypher generates a device key pair locally. The private key is written to your OS keychain and never transmitted.</p>
        </Step>
        <Step title="Pair a second device">
          <p>On device A choose <strong>Pair a device</strong> to show a one-time code (and a QR). Enter it on device B. The two exchange public keys directly; the code is never sent to the relay.</p>
        </Step>
        <Step title="Pick what syncs">
          <p>Sync the whole vault, or select folders. Each synced document converges across every paired device — edit offline on one and they merge cleanly when both are online.</p>
        </Step>
      </Steps>

      <h2 id="default-relay">The default relay</h2>
      <p>
        Out of the box, Cypher uses <code>wss://relay.cypher.md</code> for the
        introduce/fallback step. It holds no accounts, keeps no message log, and is
        structurally unable to decrypt your documents. If that's not enough trust —
        and it shouldn't have to be — point Cypher at your own.
      </p>
      <Code file="Settings → Sync → Relay" lang="text" code={`
Relay URL    wss://relay.cypher.md      (default)
             wss://relay.example.org    (your own — see Self-hosting)
`} />

      <h2 id="own-relay">Use your own relay</h2>
      <p>It's a single config field. Paste a WebSocket URL and Cypher uses it for every introduction and fallback:</p>
      <Code lang="bash" code={`
# or set it without opening the UI:
cypher config set sync.relay wss://relay.example.org
`} />
      <Callout kind="tip" title="Your relay, your rules.">
        Running your own relay means no third party — not even the Cypher project —
        is ever in the path of an introduction. Setup is one container. See{" "}
        <A href="/docs/app/self-hosting">Self-hosting the relay</A>.
      </Callout>

      <h2 id="troubleshoot">When devices won't pair</h2>
      <PropsTable cols={["Symptom", "Likely cause", "Fix"]} rows={[
        { name: "Stuck on 'introducing'", type: "Relay unreachable", desc: "Check the relay URL and that your network allows outbound WSS (443)." },
        { name: "Pairs, then 'fallback'", type: "Strict NAT both ends", desc: "Expected — sync still works, just via the encrypted relay path. Nothing to fix." },
        { name: "Code rejected", type: "Code expired", desc: "Pairing codes are single-use and time-boxed. Generate a fresh one." },
      ]} />
    </>
  );
}

export function AppSelfHosting() {
  return (
    <>
      <p className="dx-lede">
        The relay is a small, stateless service: it introduces peers and forwards
        encrypted bytes it cannot read. <strong>It has no database, no accounts, and
        nothing worth subpoenaing.</strong> Running your own takes one container.
      </p>

      <h2 id="run">Run it</h2>
      <p>The relay ships as a container image and a single static binary. Either works:</p>
      <Code lang="bash" code={`
# container
docker run -p 443:8443 \\
  -v $PWD/certs:/certs \\
  ghcr.io/hamza512b/cypher-relay:latest

# or the static binary
cypher-relay --listen :8443 --tls-cert ./fullchain.pem --tls-key ./key.pem
`} />
      <p>Then point your app at it: <code>Settings → Sync → Relay → wss://relay.example.org</code>.</p>

      <h2 id="config">Configuration</h2>
      <PropsTable cols={["Flag", "Default", "Description"]} rows={[
        { name: "--listen", type: ":8443", desc: "Address and port to bind the WebSocket listener." },
        { name: "--tls-cert / --tls-key", type: "—", desc: "PEM files for WSS. Terminate TLS here or at a proxy in front." },
        { name: "--max-room-size", type: "32", desc: "Peers allowed in one room before new joins are refused." },
        { name: "--idle-timeout", type: "60s", desc: "Drop a peer connection after this long with no traffic." },
        { name: "--metrics", type: "off", desc: "Expose Prometheus counters (connections, bytes forwarded) — no peer identities." },
      ]} />

      <Callout kind="note" title="What it never stores.">
        There is no on-disk state. Restart it and nothing is lost because there was
        nothing to lose — no message history, no peer directory, no account table.
        Memory holds only the live set of currently-connected rooms.
      </Callout>

      <h2 id="harden">Hardening notes</h2>
      <ul>
        <li><strong>Put it behind a reverse proxy</strong> (Caddy, nginx) for automatic TLS and to keep the binary off port 443 directly.</li>
        <li><strong>It forwards opaque ciphertext</strong> — there is no decryption key on the server to protect, which is the whole point. Logs, even at debug level, contain no plaintext.</li>
        <li><strong>Scale horizontally</strong> by running several behind a load balancer with sticky sessions per room; peers in one room must land on one instance.</li>
      </ul>
    </>
  );
}

export function AppPrivacy() {
  const ledger: [string, string][] = [
    ["Your email address", "never asked"],
    ["Your name", "never asked"],
    ["Your documents", "never uploaded — they stay on your disk"],
    ["Who you sync with", "never logged — the relay forgets immediately"],
    ["Your editing habits", "never tracked — there is no analytics SDK"],
    ["Device fingerprint", "never collected"],
    ["Crash reports", "shown to you locally; sent nowhere unless you copy them yourself"],
  ];
  return (
    <>
      <p className="dx-lede">
        The short version: <strong>Cypher does not have a file on you, because it
        never opens one.</strong> No accounts, no telemetry, no document upload.
        Here is the complete accounting.
      </p>

      <h2 id="ledger">What we know about you</h2>
      <div className="dx-table-wrap">
        <table className="dx-table">
          <thead><tr><th>Data point</th><th>Status</th></tr></thead>
          <tbody>
            {ledger.map(([k, v]) => (
              <tr key={k}>
                <td className="desc" style={{ color: "var(--fg)" }}>{k}</td>
                <td><span className="ty" style={{ fontStyle: "normal" }}>{v}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 id="where">Where your work actually lives</h2>
      <ul>
        <li><strong>On your device.</strong> Every keystroke lands in your vault folder as plain markdown. No round-trip, no server copy.</li>
        <li><strong>Between your devices.</strong> If you enable sync, documents are encrypted on-device before they cross any wire. Only your paired devices hold the keys.</li>
        <li><strong>Through a relay — only when needed.</strong> When a direct connection can't be made, an encrypted blob passes through a relay that cannot decrypt it and keeps no record of it.</li>
      </ul>

      <Callout kind="tip" title="Don't trust the page — read the code.">
        Every claim here is enforced by source you can audit. The encryption, the
        relay, and the protocol are all in the <A href={REPO}>GPL-3.0 repository</A>.
        Fork it, swap the relay, or ship your own build — every fork inherits the
        same refusal.
      </Callout>

      <h2 id="keys">Your keys</h2>
      <p>
        Encryption keys are generated on your device and stored in your operating
        system's keychain. They never leave your hardware and are never escrowed
        with anyone. There is no key-recovery service — which also means there is no
        master key for anyone to compel. If you lose every paired device, your
        encrypted sync data is unrecoverable by design; your plain-markdown vault on
        disk is, of course, still right there.
      </p>
    </>
  );
}

export function AppTroubleshooting() {
  const faqs: [string, string][] = [
    ["Is there an account or login?", "No. Cypher has no account system at all. There is nothing to sign up for, nothing to log into, and nothing to delete when you leave — you walk away by closing the app."],
    ["Where are my files stored?", "In the vault folder you chose on first launch, as plain .md files. Open them in any editor, move them, back them up, or put them in git — Cypher reads and writes that folder and nothing else."],
    ["Do I need the internet?", "No. Cypher is local-first: it works fully offline. The network is only ever used for optional sync, and even then only to reach your own other devices."],
    ["Can the relay read my notes?", "No. Documents are encrypted end-to-end on your device before anything leaves it. The relay forwards opaque bytes and keeps no log — it is structurally unable to decrypt your work, not merely promising not to."],
    ["What happens if the Cypher project disappears?", "Your files are plain markdown on your disk, untouched. The app is GPL-3.0, so the source can be built and maintained by anyone. Nothing about your data depends on us existing."],
    ["How do I move to a new computer?", "Copy your vault folder over — that's your data. Then install Cypher and point it at the folder. If you use sync, pair the new device from an existing one."],
  ];
  return (
    <>
      <p className="dx-lede">
        Common questions, and fixes for the handful of things that can go sideways.
        If something here doesn't cover it, the <A href={`${REPO}/issues`}>issue tracker</A> is the place.
      </p>

      <h2 id="faq">Frequently asked</h2>
      <div className="dx-table-wrap">
        <table className="dx-table">
          <tbody>
            {faqs.map(([q, a]) => (
              <tr key={q}>
                <td className="name" style={{ width: "34%", whiteSpace: "normal", color: "var(--fg)", fontWeight: 600, verticalAlign: "top" }}>{q}</td>
                <td className="desc">{a}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 id="reset">Common fixes</h2>
      <PropsTable cols={["Problem", "Cause", "Fix"]} rows={[
        { name: "App won't open my vault", type: "Folder permissions", desc: "Grant Cypher access to the folder in your OS privacy settings, or re-pick the vault in Settings → Vault." },
        { name: "Sync stuck 'introducing'", type: "Relay unreachable", desc: "Verify the relay URL and that outbound WSS (443) isn't blocked. Try your own relay." },
        { name: "Edits not appearing on device B", type: "Device B offline", desc: "Both devices must be online to converge. They'll merge automatically once B reconnects." },
        { name: "Markdown shortcut didn't fire", type: "Caret mid-line", desc: "Block shortcuts (#, >, -) only trigger at the start of a line." },
      ]} />

      <Callout kind="warn" title="Before you reset anything.">
        Your vault is plain files — resetting the app never touches them. But if you
        use sync and unpair every device, encrypted sync state held only on those
        devices can't be recovered. Your on-disk markdown is always safe.
      </Callout>
    </>
  );
}

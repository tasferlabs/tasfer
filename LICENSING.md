# Licensing

Tasfer is **dual-licensed by directory**. The deployable apps are copyleft; the
reusable `@cypherkit/*` libraries are permissive so anyone can build on them —
including in closed-source and commercial products — with no friction.

| Path                                                          | License               | Why                                                                                                              |
| ------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/*` (`@cypherkit/*`)                                 | **MIT**               | The product's reusable core. Embed it in anything, commercial or proprietary, no obligations beyond attribution. |
| `examples/*`, and any `example`/`examples` dir in a package   | **MIT**               | Meant to be copy-pasted into your own apps.                                                                      |
| `apps/*` (`web`, `desktop`, `live`, `site`, `ios`, `android`) | **AGPL-3.0-or-later** | The deployable products. Forks and hosted/network deployments must share their source.                           |

The canonical copyleft text lives in the root [`LICENSE`](LICENSE) (AGPL-3.0),
and the canonical permissive text in the root [`LICENSE-MIT`](LICENSE-MIT).
Each app, package, and example also carries its own `LICENSE` (the apps an
AGPL-3.0 copy, the packages/examples an MIT copy) and — for the packages and
examples — a `"license"` field in its `package.json`, which is what npm and
license scanners read.

## Third-party material

Some code bundles third-party components under their own (permissive) licenses,
whose attribution notices must travel with every distribution:

- **`@cypherkit/tex`** vendors KaTeX (MIT) font faces, font metrics, and symbol
  tables. Its [`NOTICE`](packages/tex/NOTICE) reproduces the required KaTeX
  copyright and license, and the npm package ships that `NOTICE`.
- **The deployed apps** bundle their npm dependencies (and the vendored KaTeX
  material above). `apps/web` aggregates every bundled dependency's license into
  `public/THIRD-PARTY-LICENSES.txt` (regenerated at build by
  `apps/web/scripts/gen-third-party-licenses.mjs`), served from the app and
  linked from its in-app Information panel.

Combining MIT code into the AGPL apps is fine: MIT is one-way compatible into
AGPL. Each MIT-licensed file keeps its MIT grant, while the combined deployed app
is governed by the AGPL.

## Commercial / proprietary use

- **The libraries (`packages/*`) are MIT** — use them in commercial and
  closed-source software freely.
- **The apps are AGPL** for the public. As the sole copyright holder, Tasfer's
  owner additionally offers the apps under separate commercial terms (including
  the App Store / Play Store builds), which is permitted because a copyright
  holder is not bound by their own copyleft license.

> **Note for contributors:** because the apps are dual-licensed (AGPL **and**
> commercial), contributions to `apps/*` are accepted under a Contributor License
> Agreement that grants the project owner the right to relicense them. See
> `CONTRIBUTING.md`.

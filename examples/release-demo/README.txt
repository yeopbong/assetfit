AssetFit measured release case

Source repository: https://github.com/yeopbong/assetfit
Online explorer: https://yeopbong.github.io/assetfit/

To process your own files locally, install Node.js 22.13+, pnpm 11.19.0 and Chrome or Playwright Chromium. Clone the repository, then run these commands on separate lines:

git clone https://github.com/yeopbong/assetfit.git
cd assetfit
pnpm install --frozen-lockfile
pnpm build
pnpm start

Open http://127.0.0.1:4318 on the same computer. If Chrome is unavailable, run pnpm exec playwright install chromium. For an occupied port use pnpm start --port 4319. Quote a checkout path containing spaces. Tested local processing: macOS arm64 with Node 24.19.0, pnpm 11.19.0 and Chrome 152.0.7977.76. See the repository README and docs/RC.md for verification scope and limits.

This archive contains real source-derived candidate files and measured comparisons. Candidate generation is precomputed; the static browser application re-solves the recorded table and creates real ZIP downloads for any feasible selected budget. SOURCES.json contains the four assets' individual licenses and attribution.

Reproduce from the repository root: node scripts/release-case.mjs
Configuration: examples/release-config.json
Detailed outcome and accounting: docs/release-case.md and docs/release-case.json

Only downloads/standard.zip is included as a ready-made complete delivery. Every tier retains its manifest, recipe, policy and machine-readable report JSON. The other original local ZIPs and standalone HTML reports are not included in this archive. Download any feasible tier from the online explorer, or regenerate all tiers with pnpm release:case. The packaging revision changes no candidate bytes or quality measurements.

The 7,000,000-byte standard and 9,000,000-byte high budgets select the same files because the next strictly better weighted-loss combination in the measured table requires 9,877,623 bytes. All 768 combinations were enumerated; unused budget does not force a quality change.

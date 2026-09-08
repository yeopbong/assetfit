AssetFit sample archive

Online explorer: https://yeopbong.github.io/assetfit/
Source: https://github.com/yeopbong/assetfit

This archive contains precomputed candidates and comparisons. The browser selects from them and generates ZIP downloads. Use the local application for new files:

git clone https://github.com/yeopbong/assetfit.git
cd assetfit
pnpm install --frozen-lockfile
pnpm build
pnpm start

Requires Node.js 22.13+, pnpm 11.19.0 and Chrome or Playwright Chromium for GLB processing. Open http://127.0.0.1:4318. If needed, run pnpm exec playwright install chromium or use pnpm start --port 4319.

SOURCES.json records asset attribution and licenses. Budgets count selected asset bytes; ZIP and metadata add overhead. downloads/standard.zip is ready to use. Other tiers retain JSON reports and recipes; download their ZIPs through the explorer.

To regenerate the sample, run pnpm release:case. Configuration: examples/release-config.json. Saved results: docs/release-case.json.

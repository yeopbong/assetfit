# AssetFit

Fit images and static 3D models into one shared file-size budget. AssetFit generates and compares versions of your JPEG, PNG, WebP and GLB files, then selects one version of every asset. Display sizes, importance and protection settings guide the selection.

![AssetFit with mixed assets, comparisons and a shared byte budget](docs/images/demo-desktop.png)

[Try the online demo](https://yeopbong.github.io/assetfit/) · [Source repository](https://github.com/yeopbong/assetfit)

The online demo uses existing candidates. Change the budget or importance to select and download sample files. Run the local application to process new files.

## Run locally

Install **Node.js 22.13+** and **pnpm 11.19.0**. GLB processing also needs Chrome or Playwright Chromium; image-only CLI processing does not need a browser.

```sh
git clone https://github.com/yeopbong/assetfit.git
cd assetfit
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open [127.0.0.1:4318](http://127.0.0.1:4318). If Chrome is unavailable, run `pnpm exec playwright install chromium`. For an occupied port, use `pnpm start --port 4319`.

1. Choose **New project**, then **Add files** or **Load sample**.
2. Set display sizes, importance and protection, then enter a total budget in bytes.
3. Choose **Generate & allocate** and inspect the comparisons.
4. Adjust the budget or importance, then choose **Download delivery**.

The delivery ZIP includes selected files, comparison reports, a manifest and a replay recipe. Processing runs locally and leaves original inputs intact. See the [user guide](docs/USAGE.md) for CLI commands, the macOS launcher and recovery.

## Before using a delivery

- The budget counts **selected asset bytes**. Embedded GLB textures count inside the model; reports and ZIP overhead are separate.
- Supported inputs are static 8-bit JPEG/PNG/WebP and self-contained static GLB 2.0 with core PBR content and `KHR_texture_transform`. Animation, skins, morph targets, external model resources and other extensions are unsupported.
- Loss is a reference-based comparison under the chosen viewing conditions. Inspect important details and use protection settings for content that must remain exact.
- Selection uses a finite candidate table. A larger budget can select the same files; an infeasible budget leaves assets and locks in place.
- Interactive 3D inspection needs WebGL. Recorded fixed-camera comparisons remain available when it is unavailable.

[Technical reference](docs/TECHNICAL.md) · [Mixed example](docs/release-case.md) · [Search benchmark](docs/benchmark-notes.md)

Code is [MIT licensed](LICENSE). Sample attribution and licenses are in [examples/SOURCES.json](examples/SOURCES.json); dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

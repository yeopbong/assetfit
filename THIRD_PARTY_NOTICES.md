# Licensing and third-party software

The MIT license in `LICENSE` applies to AssetFit's original application code and documentation. It does not replace the licenses of imported sample assets or dependencies. The release candidate's proposed code license is included for review before public publication.

Each bundled source asset and its derivatives retain the asset-specific attribution and license recorded in [examples/SOURCES.json](examples/SOURCES.json). The Duck model uses the SCEA Shared Source License, Avocado uses CC0, and the NASA photographs retain their source attribution and applicable media guidance. The original detail-sheet fixture is CC0. Downloaded deliveries carry the applicable source manifest and license text.

| Direct dependency | Version | License |
| --- | --- | --- |
| Three.js | 0.180.0 | MIT |
| JSZip | 3.10.1 | MIT option of its dual license |
| glTF Transform core, extensions and functions | 4.2.1 | MIT |
| meshoptimizer | 0.25.0 | MIT |
| glTF Validator | 2.0.0-dev.3.10 | Apache-2.0 |
| Sharp | 0.34.3 | Apache-2.0; native libraries retain their own licenses |
| Playwright | 1.55.0 | Apache-2.0; browsers retain their own licenses |
| Express | 5.1.0 | MIT |
| Multer | 2.0.2 | MIT |
| esbuild | 0.25.9 | MIT |
| TypeScript | 5.9.2 | Apache-2.0 |

Package installations include their upstream copyright, license and notice files. The lockfile records transitive dependencies. `pnpm build` extracts the complete license texts of every dependency included in the browser bundle into `dist/THIRD_PARTY_NOTICES.txt`; it fails if one is missing. Bundled source comments and license notices are preserved. No system browser or native dependency binary is redistributed in the source repository.

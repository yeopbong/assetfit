# Mixed example

The sample combines the Avocado model, NASA astronaut and Blue Marble photographs, and a protected detail graphic. Source attribution and licenses are in [examples/SOURCES.json](../examples/SOURCES.json).

Open the [online explorer](https://yeopbong.github.io/assetfit/) to change the budget, compare candidates and download a selection. The portrait has two display uses but one physical output. The detail graphic is locked to its original bytes. The standard and high budgets select the same files in the saved candidate table.

To generate a new local run after installing dependencies and a rendering browser:

```sh
pnpm release:case
```

[release-config.json](../examples/release-config.json) supplies input paths, display sizes, protections, seed and budgets. Each run creates a new managed project. [release-case.json](release-case.json) contains the saved candidates, allocations, baseline comparisons, failures, timings and delivery byte counts.

The static archive includes a standard ZIP and every tier's manifest, recipe, policy and JSON report. Use the explorer to generate another feasible ZIP. Budgets count selected visual files; ZIP and report bytes are separate.

#!/usr/bin/env python3
import argparse
import copy
import hashlib
import json
from collections import Counter
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parents[1]
METHODS = [("uniform", False, "Uniform"), ("random", False, "Random"),
           ("greedy", False, "Measured greedy"),
           ("evolutionary", False, "Evolution · ridge off"),
           ("evolutionary", True, "Evolution · ridge on")]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def extract(source):
    payload = source.read_bytes()
    original = json.loads(payload)
    data = {key: copy.deepcopy(original[key]) for key in
            ["schemaVersion", "runId", "status", "protocol", "versions", "environment", "costs"]}
    data["provenance"] = {
        "source": source.relative_to(ROOT).as_posix(), "sourceSha256": sha(payload),
        "extraction": "All original observation events retained. Candidate image paths and repeated renderer environment omitted; measurements, recipes, hashes and costs unchanged.",
        "physicalFileVerification": {"checked": 0, "bytesAndSha256Matched": 0, "measurementIdentityMatched": 0},
    }
    data["assets"] = []
    for asset in original["assets"]:
        target = {key: copy.deepcopy(value) for key, value in asset.items() if key not in ["summaries", "runs"]}
        target["runs"] = []
        for run in asset["runs"]:
            result = {key: copy.deepcopy(value) for key, value in run.items() if key != "candidates"}
            for observation in result["observations"]:
                if observation["event"] != "candidate":
                    continue
                candidate = observation["candidate"]
                if candidate["valid"]:
                    raw = (ROOT / candidate["file"]).read_bytes()
                    assert len(raw) == candidate["bytes"] and sha(raw) == candidate["hash"], candidate["file"]
                    assert candidate["metrics"]["bytes"] == candidate["bytes"]
                    assert candidate["metrics"]["hash"] == candidate["hash"]
                    checks = data["provenance"]["physicalFileVerification"]
                    for key in checks:
                        checks[key] += 1
                metrics = candidate.get("metrics")
                if metrics:
                    for key in ["images", "preview", "reference", "difference", "environment"]:
                        metrics.pop(key, None)
            target["runs"].append(result)
        data["assets"].append(target)
    return data


def audit(data):
    result = {
        "schemaVersion": 1, "runId": data["runId"], "versions": data["versions"],
        "sourceSha256": data["provenance"]["sourceSha256"],
        "physicalFileVerificationAtExtraction": data["provenance"]["physicalFileVerification"],
        "counting": "An evaluation is a candidate completion event, including invalid candidates. Repeated output hashes across independent runs remain paid observations; they are not unique candidates or cache hits.",
        "assets": [],
    }
    counters = Counter()
    initialization_ms = candidate_ms = fitting_ms = method_ms = 0
    for asset in data["assets"]:
        events = [event for run in asset["runs"] for event in run["observations"]]
        completions = [event for event in events if event["event"] == "candidate"]
        measured = [event["candidate"] for event in completions]
        counts = Counter(event["event"] for event in events)
        valid = [candidate for candidate in measured if candidate["valid"]]
        counters.update({"logicalEvaluations": len(measured), "validEvaluations": len(valid),
                         "failedEvaluations": len(measured) - len(valid),
                         "uniqueOutputHashes": len({candidate["hash"] for candidate in valid}),
                         "cacheObservations": counts["resume-cache-hit"], "retryObservations": counts["candidate-retry"],
                         "initializations": counts["initialization"],
                         "surrogateProposals": sum(event.get("phase") == "evolution-surrogate-proposal" and event["event"] == "proposal" for event in events)})
        initialization_ms += sum(event["costMs"] for event in events if event["event"] == "initialization")
        candidate_ms += sum(candidate["costMs"] for candidate in measured)
        fitting_ms += sum(event.get("trainingMs", 0) for event in events if event["event"] == "proposal")
        method_ms += sum(run["physicalMs"] for run in asset["runs"])
        initializations = []
        rows = []
        for run in asset["runs"]:
            observations = [event for event in run["observations"] if event["event"] == "candidate"]
            assert len(observations) == run["logicalEvaluations"]
            assert len({tuple(event["vector"]) for event in observations}) == len(observations)
            initializations.append([(event["candidate"]["hash"], event["candidate"]["metrics"]["loss"]) for event in observations[:5]])
            candidates = [event["candidate"] for event in observations if event["candidate"]["valid"]]
            best = min(candidates, key=lambda item: item["metrics"]["loss"] + .2 * item["bytes"] / asset["sourceBytes"])
            rows.append({"method": run["method"], "surrogate": run["surrogate"], "seed": run["seed"],
                         "logicalEvaluations": run["logicalEvaluations"], "physicalMs": run["physicalMs"],
                         "bestObjective": best["metrics"]["loss"] + .2 * best["bytes"] / asset["sourceBytes"],
                         "bestHash": best["hash"], "bestBytes": best["bytes"], "bestLoss": best["metrics"]["loss"],
                         "budgets": [{"ratio": ratio, "budget": int(asset["sourceBytes"] * ratio),
                                      "feasibleInArchive": any(candidate["bytes"] <= int(asset["sourceBytes"] * ratio) for candidate in candidates)}
                                     for ratio in data["protocol"]["budgetRatios"]]})
        assert all(value == initializations[0] for value in initializations)
        paired_proposals = []
        for seed in data["protocol"]["seeds"]:
            pair = [run for run in asset["runs"] if run["method"] == "evolutionary" and run["seed"] == seed]
            vectors = {str(run["surrogate"]).lower(): [event["vector"] for event in run["observations"] if event["event"] == "proposal"][5:] for run in pair}
            paired_proposals.append({"seed": seed, "vectors": vectors, "differentSequence": vectors["false"] != vectors["true"]})
        result["assets"].append({"name": asset["name"], "sourceHash": asset["sourceHash"], "sourceBytes": asset["sourceBytes"],
                                 "eventCounts": dict(counts), "uniqueOutputHashes": len({candidate["hash"] for candidate in valid}),
                                 "commonFirstFiveHashesAndLossesMatch": True, "pairedEvolutionProposals": paired_proposals,
                                 "runs": rows,
                                 "methods": [{"method": method, "surrogate": surrogate, "label": label,
                                              "meanObjective": mean(row["bestObjective"] for row in rows if row["method"] == method and row["surrogate"] == surrogate),
                                              "meanPhysicalSeconds": mean(row["physicalMs"] / 1000 for row in rows if row["method"] == method and row["surrogate"] == surrogate)}
                                             for method, surrogate, label in METHODS]})
    assert counters["logicalEvaluations"] == data["costs"]["logicalEvaluations"]
    result["counts"] = dict(counters)
    result["costs"] = {**data["costs"], "initializationMsWithinMethods": initialization_ms,
                       "candidateMsWithinMethods": candidate_ms,
                       "surrogateFittingAndRankingMsWithinMethods": fitting_ms,
                       "otherMethodOverheadMs": method_ms - initialization_ms - candidate_ms - fitting_ms,
                       "orchestrationAndShutdownMs": data["costs"]["totalMs"] - method_ms - data["costs"]["rendererStartupMs"] - data["costs"]["originalReferenceMs"],
                       "note": "Within-method components partition methodPhysicalMs; do not add them again. Candidate transform, encode, validate and evaluate timings are further subsets, not additional costs."}
    return result


def plot(report):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D
    matplotlib.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False,
                               "axes.spines.right": False, "axes.spines.left": False, "svg.hashsalt": "assetfit-benchmark"})
    fig, axes = plt.subplots(1, 2, figsize=(12.8, 6.4))
    fig.subplots_adjust(left=.165, right=.91, top=.74, bottom=.33, wspace=.38)
    ink, blue, gray = "#172b3a", "#1769a0", "#8c9baa"
    fig.suptitle("Simple search remains competitive", x=.03, y=.98, ha="left", fontsize=20, fontweight="bold", color=ink)
    fig.text(.03, .91, "Best measured objective per run: search loss + 0.2 × candidate bytes / source bytes. Lower is better.", color=ink)
    fig.text(.03, .868, "Three fixed seeds (11, 22, 33). Uniform: 5 evaluations/run; other methods: 8. Each run pays its own initialization.", fontsize=9, color=ink)
    for ax, asset in zip(axes, report["assets"]):
        ax.set_title(f"{asset['name']} · {asset['sourceBytes']:,} source bytes", loc="left", color=ink, pad=15, fontsize=12)
        for index, (method, surrogate, label) in enumerate(METHODS):
            runs = [run for run in asset["runs"] if run["method"] == method and run["surrogate"] == surrogate]
            values = [run["bestObjective"] for run in runs]
            ax.hlines(index, min(values), max(values), color=gray, linewidth=1.5)
            for value, offset, marker in zip(values, [-.13, 0, .13], ["o", "s", "^"]):
                ax.scatter(value, index + offset, marker=marker, facecolor="white", edgecolor=gray, s=27, zorder=3)
            ax.scatter(mean(values), index, marker="D", c=blue, s=34, zorder=4)
            ax.text(1.035, index, f"{mean(values):.6f}", transform=ax.get_yaxis_transform(), va="center", fontsize=9, color=ink)
        ax.set_yticks(range(5), [label for _, _, label in METHODS])
        if asset["name"] != "Duck":
            ax.tick_params(axis="y", labelleft=False)
        ax.set_ylim(4.65, -.65)
        ax.grid(axis="x", color="#e2e7ec", linewidth=.7)
        ax.set_axisbelow(True)
        ax.tick_params(axis="y", length=0, labelcolor=ink)
        ax.tick_params(axis="x", length=3, colors=ink)
        ax.spines["bottom"].set_color(gray)

        if asset["name"] == "Duck":
            ax.set_xlim(.046, .052)
            ax.set_xticks([.046, .048, .050, .052])
        else:
            ax.set_xlim(.124, .132)
            ax.set_xticks([.124, .126, .128, .130, .132])
        ax.set_xlabel("Objective · zoomed axis", labelpad=10, color=ink)
    handles = [Line2D([0], [0], marker="D", color="none", markerfacecolor=blue, markeredgecolor=blue, label="Mean"),
               Line2D([0], [0], marker="o", color="none", markerfacecolor="white", markeredgecolor=gray, label="Seed 11"),
               Line2D([0], [0], marker="s", color="none", markerfacecolor="white", markeredgecolor=gray, label="Seed 22"),
               Line2D([0], [0], marker="^", color="none", markerfacecolor="white", markeredgecolor=gray, label="Seed 33")]
    fig.legend(handles=handles, loc="lower left", bbox_to_anchor=(.025, .205), ncol=4, frameon=False, fontsize=9)
    fig.text(.03, .184, "Duck: every method ties. Avocado: greedy has the lowest mean; ridge improves evolution alone but does not beat greedy.", color=ink, fontsize=10)
    fig.text(.03, .128, "Panels have independent zoomed scales. Points show three runs, not confidence intervals; compare methods within each asset.", fontsize=9, color=ink)
    fig.text(.03, .084, "Recorded pipeline: assetfit-glb-1.0.1 · 222 paid evaluations / 36 unique output hashes · 88.8 s end to end.", fontsize=9, color=ink)
    fig.text(.03, .041, "Source: docs/benchmark-observations.json. Timings and byte-budget feasibility are reported separately in benchmark-notes.md.", fontsize=8, color=ink)
    output = ROOT / "docs" / "images"
    output.mkdir(parents=True, exist_ok=True)
    fig.savefig(output / "benchmark-comparison.png", dpi=180, facecolor="white", metadata={"Software": "Matplotlib"})
    fig.savefig(output / "benchmark-comparison.svg", facecolor="white", metadata={"Date": None, "Creator": "Matplotlib"})
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description="Plot recorded GLB observations from docs; --extract reads and verifies a full benchmark report.")
    parser.add_argument("--extract", type=Path, help="Full report under the repository root; candidate files must exist.")
    args = parser.parse_args()
    evidence_path = ROOT / "docs" / "benchmark-observations.json"
    if args.extract:
        evidence = extract(args.extract.resolve())
        save(evidence_path, evidence)
    else:
        evidence = json.loads(evidence_path.read_text())
    result = audit(evidence)
    save(ROOT / "docs" / "benchmark-audit.json", result)
    plot(result)
    print(json.dumps({"counts": result["counts"], "costs": result["costs"], "figure": "docs/images/benchmark-comparison.png"}, indent=2))


if __name__ == "__main__":
    main()

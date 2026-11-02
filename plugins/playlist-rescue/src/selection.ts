import type { Finding, PlaylistScan } from "./scan";

export type UnmatchedPolicy = "keep" | "remove";

export const findingKey = (playlist: PlaylistScan, finding: Finding) => `${playlist.uuid}:${finding.index}`;

/** A track with a playable version starts checked. Losing a song for good needs the "remove" policy or an explicit tick. */
export const preselect = (scans: PlaylistScan[], unmatched: UnmatchedPolicy): Set<string> => {
	const selected = new Set<string>();
	for (const playlist of scans) {
		for (const finding of playlist.findings) {
			const wanted = finding.status === "replace" || finding.status === "already-present" || (finding.status === "no-match" && unmatched === "remove");
			if (wanted) selected.add(findingKey(playlist, finding));
		}
	}
	return selected;
};

export const chosenFindings = (playlist: PlaylistScan, selected: Set<string>): Finding[] =>
	playlist.findings.filter((finding) => finding.status !== "unverified" && selected.has(findingKey(playlist, finding)));

export const summarize = (scans: PlaylistScan[], selected: Set<string>) => {
	const chosen = scans.flatMap((playlist) => chosenFindings(playlist, selected));
	const replaced = chosen.filter((finding) => finding.status === "replace").length;
	return { replaced, removed: chosen.length - replaced };
};

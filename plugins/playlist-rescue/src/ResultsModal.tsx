import React, { useState } from "react";

import type { Track } from "./matcher";
import { FAVORITES_UUID, type Finding, type PlaylistScan } from "./scan";
import { findingKey, preselect, summarize, type UnmatchedPolicy } from "./selection";

const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const artistsOf = (track: Track) => (track.artists ?? []).map((artist) => artist.name).join(", ");

const titleOf = (track: Track) => (track.version ? `${track.title} (${track.version})` : track.title);

const qualityLabel = (track: Track) => {
	if (track.mediaMetadata?.tags?.includes("HIRES_LOSSLESS")) return "Hi-Res";
	if (track.audioQuality === "LOSSLESS") return "Lossless";
	return track.audioQuality ?? "";
};

const Badge = ({ color, children }: { color: string; children: string }) => (
	<span style={{ fontSize: "9px", fontWeight: 600, padding: "1px 5px", borderRadius: "3px", marginRight: "3px", whiteSpace: "nowrap", color, background: "rgba(255,255,255,0.08)" }}>{children}</span>
);

const Reasons = ({ finding }: { finding: Finding }) => {
	switch (finding.status) {
		case "replace":
			return (
				<>
					{finding.match!.kind === "isrc" ? <Badge color="rgba(80,200,120,0.9)">SAME RECORDING</Badge> : <Badge color="rgba(100,160,255,0.9)">SAME TITLE, ARTIST AND LENGTH</Badge>}
					{finding.match!.metadataDiffers && <Badge color="rgba(255,200,100,0.9)">DIFFERENT NAME, PLEASE CHECK</Badge>}
				</>
			);
		case "already-present":
			return <Badge color="rgba(80,200,120,0.9)">ALREADY THERE</Badge>;
		case "unverified":
			return <Badge color="rgba(255,255,255,0.6)">UNVERIFIED, IGNORED</Badge>;
		case "no-match":
			return <Badge color="rgba(255,120,120,0.95)">NO VERSION ON TIDAL</Badge>;
	}
};

const outcome = (finding: Finding, checked: boolean, inFavorites: boolean) => {
	if (finding.status === "unverified") return "Kept as is: TIDAL did not confirm that it cannot be played.";
	if (!checked) return "Kept as is.";
	if (finding.status === "no-match") return "Will be removed without a replacement, and cannot be added back.";
	if (finding.status === "already-present") return "The dead entry will be removed, the available version stays.";
	const track = finding.match!.track;
	const where = inFavorites ? "added to your favorites" : "at the same position";
	return `→ ${titleOf(track)} — ${artistsOf(track)}${track.album?.title ? ` · ${track.album.title}` : ""} (${where})`;
};

const FindingRow = ({ finding, checked, inFavorites, onToggle }: { finding: Finding; checked: boolean; inFavorites: boolean; onToggle: () => void }) => {
	const replacement = finding.status === "replace" ? finding.match!.track : undefined;
	const removing = checked && finding.status === "no-match";
	return (
		<label
			style={{
				display: "flex",
				alignItems: "center",
				gap: "10px",
				padding: "8px 12px",
				marginBottom: "6px",
				cursor: finding.status === "unverified" ? "default" : "pointer",
				userSelect: "none",
				border: "1px solid rgba(255,255,255,0.08)",
				borderRadius: "6px",
				background: removing ? "rgba(255,80,80,0.1)" : checked ? "rgba(80,200,120,0.08)" : "rgba(255,255,255,0.03)",
			}}
		>
			<input type="checkbox" checked={checked} disabled={finding.status === "unverified"} onChange={onToggle} style={{ flexShrink: 0 }} />
			<div style={{ flex: 1, minWidth: 0 }}>
				<div style={{ marginBottom: "3px" }}>
					<Reasons finding={finding} />
				</div>
				<div style={{ fontSize: "13px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{titleOf(finding.dead)}</div>
				<div style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)", marginTop: "2px" }}>
					{artistsOf(finding.dead)}
					{finding.dead.album?.title && <span style={{ marginLeft: "6px", color: "rgba(255,255,255,0.35)" }}>— {finding.dead.album.title}</span>}
					<span style={{ marginLeft: "6px", color: "rgba(255,255,255,0.25)" }}>
						{!inFavorites && <>#{finding.index + 1} · </>}ID:{finding.dead.id}
					</span>
				</div>
				<div style={{ fontSize: "12px", marginTop: "4px", color: removing ? "rgba(255,150,150,0.95)" : replacement && checked ? "#fff" : "rgba(255,255,255,0.55)" }}>{outcome(finding, checked, inFavorites)}</div>
			</div>
			<div style={{ flexShrink: 0, textAlign: "right", fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>
				{replacement && <div>{qualityLabel(replacement)}</div>}
				<div>{formatDuration(replacement?.duration ?? finding.dead.duration)}</div>
			</div>
		</label>
	);
};

const footerButton = (enabled: boolean): React.CSSProperties => ({
	padding: "8px 16px",
	background: enabled ? "rgba(80,200,120,0.5)" : "rgba(80,200,120,0.15)",
	border: "1px solid rgba(80,200,120,0.4)",
	borderRadius: "4px",
	color: "#fff",
	cursor: enabled ? "pointer" : "not-allowed",
	fontSize: "13px",
	fontWeight: 500,
});

interface Props {
	scans: PlaylistScan[];
	unmatched: UnmatchedPolicy;
	onConfirm: (selected: Set<string>) => void;
	onCancel: () => void;
}

export const ResultsModal = ({ scans, unmatched, onConfirm, onCancel }: Props) => {
	const [selected, setSelected] = useState(() => preselect(scans, unmatched));

	const toggle = (key: string) =>
		setSelected((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	const { replaced, removed } = summarize(scans, selected);
	const total = replaced + removed;
	const count = scans.reduce((sum, playlist) => sum + playlist.findings.length, 0);

	return (
		<div data-test="playlist-rescue-modal" style={{ position: "fixed", inset: 0, zIndex: 999999, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onCancel}>
			<div
				style={{ background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "8px", width: "min(760px, 90vw)", maxHeight: "80vh", display: "flex", flexDirection: "column", color: "#fff" }}
				onClick={(event) => event.stopPropagation()}
			>
				<div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.1)", flexShrink: 0 }}>
					<div style={{ fontSize: "16px", fontWeight: 600 }}>
						{count} unavailable {count > 1 ? "tracks" : "track"} found
					</div>
					<div style={{ fontSize: "12px", color: "rgba(255,255,255,0.5)", marginTop: "4px" }}>Only the ticked tracks will be changed. A dead track that gets removed cannot be added back.</div>
				</div>

				<div style={{ overflowY: "auto", flex: 1, padding: "12px 20px" }}>
					{scans.map((playlist) => (
						<div key={playlist.uuid} style={{ marginBottom: "16px" }}>
							<div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "8px", color: "rgba(255,255,255,0.8)" }}>
								{playlist.title}
								<span style={{ fontSize: "11px", fontWeight: 400, marginLeft: "8px", color: "rgba(255,255,255,0.45)" }}>
									{playlist.findings.length}/{playlist.total}
									{playlist.isPublic ? " · public" : ""}
								</span>
							</div>
							{playlist.findings.map((finding) => (
								<FindingRow
									key={finding.index}
									finding={finding}
									inFavorites={playlist.uuid === FAVORITES_UUID}
									checked={selected.has(findingKey(playlist, finding))}
									onToggle={() => toggle(findingKey(playlist, finding))}
								/>
							))}
						</div>
					))}
				</div>

				<div style={{ padding: "12px 20px", borderTop: "1px solid rgba(255,255,255,0.1)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
					<span style={{ fontSize: "13px", color: removed > 0 ? "rgba(255,200,100,0.9)" : "rgba(255,255,255,0.6)" }}>
						{replaced} replaced, {removed} removed
					</span>
					<div style={{ display: "flex", gap: "8px" }}>
						<button onClick={onCancel} style={{ padding: "8px 16px", background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "4px", color: "#fff", cursor: "pointer", fontSize: "13px" }}>
							Cancel
						</button>
						<button onClick={() => onConfirm(selected)} disabled={total === 0} style={footerButton(total > 0)}>
							{`Apply (${total})`}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
};

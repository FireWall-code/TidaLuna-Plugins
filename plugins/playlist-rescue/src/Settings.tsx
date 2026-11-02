import React, { useEffect, useRef, useState } from "react";

import { LunaSettings, LunaSwitchSetting } from "@luna/ui";

import { refreshClient, tidalClient } from "./client";
import { storage, trace } from "./index";
import { describeTrack, JOURNAL_MAX, toJournalEntry } from "./journal";
import type { MatchOptions } from "./matcher";
import { repairFavorites, repairPlaylist } from "./repair";
import { ResultsModal } from "./ResultsModal";
import { FAVORITES_UUID, scanPlaylists, toEdit, type PlaylistInfo, type PlaylistScan } from "./scan";
import { chosenFindings, type UnmatchedPolicy } from "./selection";

const HEADING: React.CSSProperties = { fontSize: "14px", fontWeight: 500, color: "#fff", marginBottom: "8px" };

interface Progress {
	current: number;
	total: number;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const formatEta = (seconds: number) => (seconds < 60 ? `${Math.ceil(seconds)}s` : `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`);

const ProgressBar = ({ current, total }: Progress) => {
	const started = useRef({ at: Date.now(), total });
	if (started.current.total !== total) started.current = { at: Date.now(), total };
	const percent = total > 0 ? Math.round((current / total) * 100) : 0;
	const elapsed = (Date.now() - started.current.at) / 1000;
	const eta = current > 0 && current < total ? formatEta(((total - current) * elapsed) / current) : "";
	return (
		<div style={{ marginTop: "8px" }}>
			<div style={{ height: "4px", borderRadius: "2px", background: "rgba(255,255,255,0.1)", overflow: "hidden" }}>
				<div style={{ height: "100%", borderRadius: "2px", background: "rgba(80,200,120,0.7)", width: `${percent}%`, transition: "width 0.2s ease" }} />
			</div>
			<div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "rgba(255,255,255,0.5)", marginTop: "4px" }}>
				<span>{eta ? `about ${eta} left` : " "}</span>
				<span>
					{current}/{total} ({percent}%)
				</span>
			</div>
		</div>
	);
};

const RadioOption = ({ name, label, desc, checked, onChange }: { name: string; label: string; desc: string; checked: boolean; onChange: () => void }) => (
	<label style={{ display: "flex", alignItems: "center", padding: "6px 0", cursor: "pointer", userSelect: "none" }}>
		<input type="radio" name={name} checked={checked} onChange={onChange} style={{ marginRight: "10px", flexShrink: 0 }} />
		<div>
			<div style={{ fontSize: "13px", color: "#fff" }}>{label}</div>
			<div style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)" }}>{desc}</div>
		</div>
	</label>
);

const PlaylistRow = ({ playlist, checked, onToggle }: { playlist: PlaylistInfo; checked: boolean; onToggle: () => void }) => (
	<label
		data-test="playlist-rescue-row"
		style={{
			display: "flex",
			alignItems: "center",
			padding: "8px 12px",
			cursor: "pointer",
			userSelect: "none",
			borderBottom: "1px solid rgba(255,255,255,0.05)",
			background: checked ? "rgba(255,255,255,0.05)" : "transparent",
		}}
	>
		<input type="checkbox" checked={checked} onChange={onToggle} style={{ marginRight: "10px", flexShrink: 0 }} />
		<span style={{ fontSize: "13px", color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{playlist.title}</span>
		{playlist.isPublic && <span style={{ fontSize: "10px", color: "rgba(255,200,100,0.7)", marginLeft: "8px", flexShrink: 0 }}>public</span>}
		<span style={{ fontSize: "11px", color: "rgba(255,255,255,0.4)", marginLeft: "8px", flexShrink: 0 }}>{playlist.count} tracks</span>
	</label>
);

export const Settings = () => {
	const [playlists, setPlaylists] = useState<PlaylistInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [detectIsrc, setDetectIsrc] = useState(storage.detectIsrc);
	const [detectName, setDetectName] = useState(storage.detectName);
	const [prefer, setPrefer] = useState<MatchOptions["prefer"]>(storage.prefer);
	const [unmatched, setUnmatched] = useState<UnmatchedPolicy>(storage.unmatched);
	const [running, setRunning] = useState(false);
	const [status, setStatus] = useState("");
	const [progress, setProgress] = useState<Progress | null>(null);
	const [scans, setScans] = useState<PlaylistScan[] | null>(null);
	const [journalSize, setJournalSize] = useState(storage.journal.length);
	const abort = useRef<AbortController | null>(null);

	const refreshPlaylists = async () => {
		try {
			const [favorites, mine] = await Promise.all([tidalClient.favoritesInfo(), tidalClient.listPlaylists()]);
			setPlaylists([favorites, ...mine]);
		} catch (err) {
			setStatus(`Could not load your playlists: ${errorText(err)}`);
			trace.err.withContext("listPlaylists")(err);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		refreshPlaylists();
	}, []);

	const toggle = (uuid: string) =>
		setSelected((previous) => {
			const next = new Set(previous);
			if (next.has(uuid)) next.delete(uuid);
			else next.add(uuid);
			return next;
		});

	const allSelected = playlists.length > 0 && selected.size === playlists.length;
	const toggleAll = () => setSelected(allSelected ? new Set() : new Set(playlists.map((playlist) => playlist.uuid)));

	const scan = async () => {
		abort.current = new AbortController();
		const { signal } = abort.current;
		setRunning(true);
		setStatus("Searching...");
		setProgress(null);
		try {
			const targets = playlists.filter((playlist) => selected.has(playlist.uuid));
			const result = await scanPlaylists(tidalClient, targets, {
				match: { isrc: detectIsrc, name: detectName, prefer },
				signal,
				onProgress: ({ playlist, current, total }) => {
					setStatus(`Scanning "${playlist}"...`);
					setProgress({ current, total });
				},
			});
			if (signal.aborted) {
				setStatus("Search cancelled.");
				return;
			}
			const withFindings = result.filter((playlist) => playlist.findings.length > 0);
			if (withFindings.length > 0) {
				setScans(withFindings);
				setStatus("");
			} else {
				setStatus(`No unavailable tracks in ${targets.length > 1 ? `these ${targets.length} playlists` : "this playlist"}.`);
			}
		} catch (err) {
			setStatus(`Search failed: ${errorText(err)}`);
			trace.err.withContext("scan")(err);
		} finally {
			setRunning(false);
			setProgress(null);
			abort.current = null;
		}
	};

	const apply = async (chosen: Set<string>) => {
		const targets = scans ?? [];
		setScans(null);
		abort.current = new AbortController();
		const { signal } = abort.current;
		setRunning(true);
		const problems: string[] = [];
		let applied = 0;
		try {
			for (let current = 0; current < targets.length && !signal.aborted; current++) {
				const playlist = targets[current];
				const findings = chosenFindings(playlist, chosen);
				if (findings.length === 0) continue;
				setStatus(`Updating "${playlist.title}"...`);
				setProgress({ current, total: targets.length });
				const repair = playlist.uuid === FAVORITES_UUID ? repairFavorites : repairPlaylist;
				const report = await repair(tidalClient, playlist.uuid, findings.map(toEdit), {
					signal,
					onEdit: (edit) => {
						const finding = findings.find((f) => f.index === edit.index)!;
						storage.journal = [toJournalEntry(playlist, finding, new Date().toISOString()), ...storage.journal].slice(0, JOURNAL_MAX);
					},
				});
				applied += report.done.length;
				if (report.done.length > 0) refreshClient(playlist.uuid);
				if (report.error) problems.push(`${playlist.title}: ${report.error}`);
			}
			setStatus([`${applied} ${applied > 1 ? "tracks" : "track"} processed.`, ...(signal.aborted ? ["Cancelled."] : []), ...problems].join(" "));
		} catch (err) {
			setStatus(`Failed: ${errorText(err)}`);
			trace.err.withContext("apply")(err);
		} finally {
			setJournalSize(storage.journal.length);
			setRunning(false);
			setProgress(null);
			abort.current = null;
			refreshPlaylists();
		}
	};

	const noStrategy = !detectIsrc && !detectName;
	const scanDisabled = running || selected.size === 0 || noStrategy;

	return (
		<>
			<LunaSettings>
				<LunaSwitchSetting
					title="Detect by ISRC"
					desc="Looks for the same recording through its ISRC code, the most reliable method"
					checked={detectIsrc}
					onChange={(_: unknown, checked: boolean) => {
						storage.detectIsrc = checked;
						setDetectIsrc(checked);
					}}
				/>
				<LunaSwitchSetting
					title="Detect by name"
					desc="When the ISRC finds nothing: same title, a shared artist, length within 2 seconds and same explicit status"
					checked={detectName}
					onChange={(_: unknown, checked: boolean) => {
						storage.detectName = checked;
						setDetectName(checked);
					}}
				/>
				{noStrategy && <div style={{ fontSize: "11px", color: "rgba(255,200,100,0.8)", padding: "2px 0" }}>Enable at least one detection method.</div>}

				<div style={{ padding: "12px 0" }}>
					<div style={HEADING}>Replacement choice</div>
					<RadioOption
						name="rescuePrefer"
						label="Closest version"
						desc="Prefers the same album, the same artists and the same length"
						checked={prefer === "closest"}
						onChange={() => {
							storage.prefer = "closest";
							setPrefer("closest");
						}}
					/>
					<RadioOption
						name="rescuePrefer"
						label="Best quality"
						desc="Prefers Hi-Res when the same song exists in several versions"
						checked={prefer === "quality"}
						onChange={() => {
							storage.prefer = "quality";
							setPrefer("quality");
						}}
					/>
				</div>

				<div style={{ padding: "12px 0" }}>
					<div style={HEADING}>Tracks with no available version</div>
					<RadioOption
						name="rescueUnmatched"
						label="Keep"
						desc="They stay unticked in the results, you can still tick them by hand"
						checked={unmatched === "keep"}
						onChange={() => {
							storage.unmatched = "keep";
							setUnmatched("keep");
						}}
					/>
					<RadioOption
						name="rescueUnmatched"
						label="Offer to remove them"
						desc="They are ticked in the results. TIDAL does not let you add a dead track back"
						checked={unmatched === "remove"}
						onChange={() => {
							storage.unmatched = "remove";
							setUnmatched("remove");
						}}
					/>
				</div>

				<div style={{ padding: "16px 0" }}>
					<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
						<span style={{ fontSize: "14px", fontWeight: 500, color: "#fff" }}>Playlists</span>
						<label style={{ fontSize: "12px", color: "rgba(255,255,255,0.6)", cursor: "pointer", userSelect: "none" }}>
							<input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ marginRight: "4px", verticalAlign: "middle" }} />
							Select all
						</label>
					</div>
					<div style={{ maxHeight: "240px", overflowY: "auto", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "4px", background: "rgba(0,0,0,0.2)" }}>
						{loading ? (
							<div style={{ padding: "12px", fontSize: "13px", color: "rgba(255,255,255,0.5)" }}>Loading playlists...</div>
						) : (
							playlists.map((playlist) => <PlaylistRow key={playlist.uuid} playlist={playlist} checked={selected.has(playlist.uuid)} onToggle={() => toggle(playlist.uuid)} />)
						)}
					</div>
				</div>

				<div style={{ padding: "0 0 16px" }}>
					<div style={{ display: "flex", gap: "8px" }}>
						<button
							data-test="playlist-rescue-scan"
							onClick={scan}
							disabled={scanDisabled}
							style={{
								flex: 1,
								minWidth: 0,
								padding: "10px 16px",
								background: scanDisabled ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.15)",
								border: "1px solid rgba(255,255,255,0.2)",
								borderRadius: "4px",
								color: "#fff",
								cursor: scanDisabled ? "not-allowed" : "pointer",
								fontSize: "14px",
								fontWeight: 500,
							}}
						>
							{running ? status : `Find unavailable tracks (${selected.size} selected)`}
						</button>
						{running && (
							<button
								onClick={() => abort.current?.abort()}
								style={{ padding: "10px 20px", borderRadius: "4px", border: "1px solid rgba(255,100,100,0.4)", background: "transparent", color: "rgba(255,100,100,0.8)", cursor: "pointer", fontSize: "14px", fontWeight: 500, flexShrink: 0 }}
							>
								Cancel
							</button>
						)}
					</div>
					{running && progress && <ProgressBar {...progress} />}
					{!running && status && <div style={{ marginTop: "8px", fontSize: "12px", color: "rgba(255,255,255,0.6)" }}>{status}</div>}
				</div>

				{journalSize > 0 && (
					<details style={{ paddingBottom: "12px" }}>
						<summary style={{ cursor: "pointer", fontSize: "14px", fontWeight: 500, color: "#fff" }}>History ({journalSize})</summary>
						<div style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)", margin: "6px 0" }}>TIDAL refuses to add a dead track back, this history is the only record of what was removed.</div>
						<div style={{ maxHeight: "240px", overflowY: "auto" }}>
							{storage.journal.slice(0, 200).map((entry) => (
								<div key={`${entry.at}:${entry.playlistUuid}:${entry.position}`} style={{ fontSize: "12px", color: "rgba(255,255,255,0.75)", padding: "3px 0" }}>
									{entry.at.slice(0, 10)} · {entry.playlist} #{entry.position} · {entry.removed} → {entry.replacement ?? "removed"}
								</div>
							))}
						</div>
					</details>
				)}
			</LunaSettings>

			{scans !== null && <ResultsModal scans={scans} unmatched={unmatched} onConfirm={apply} onCancel={() => setScans(null)} />}
		</>
	);
};

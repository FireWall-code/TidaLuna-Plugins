import type { Track } from "./matcher";
import type { Finding } from "./scan";

/** TIDAL refuses to add a dead track back, this record is the only trace left of what was in the playlist. */
export interface JournalEntry {
	at: string;
	playlist: string;
	playlistUuid: string;
	position: number;
	removedId: number;
	removed: string;
	isrc?: string | null;
	replacementId?: number;
	replacement?: string;
}

export const JOURNAL_MAX = 1000;

export const describeTrack = (track: Track): string => {
	const artists = (track.artists ?? []).map((a) => a.name).join(", ");
	const version = track.version ? ` (${track.version})` : "";
	return `${track.title}${version} - ${artists}`;
};

export const toJournalEntry = (playlist: { uuid: string; title: string }, finding: Finding, at: string): JournalEntry => {
	const replacement = finding.status === "replace" ? finding.match?.track : undefined;
	return {
		at,
		playlist: playlist.title,
		playlistUuid: playlist.uuid,
		position: finding.index + 1,
		removedId: finding.dead.id,
		removed: describeTrack(finding.dead),
		isrc: finding.dead.isrc,
		replacementId: replacement?.id,
		replacement: replacement ? describeTrack(replacement) : undefined,
	};
};

import { DEFAULT_MATCH_OPTIONS, isDead, rankMatches, type Match, type MatchOptions, type PlaylistEdit, type Track } from "./matcher";
import type { PlaylistSnapshot } from "./repair";

/** Favorites are scanned like a playlist, but TIDAL has no position to keep there. */
export const FAVORITES_UUID = "__favorites__";

export interface PlaylistInfo {
	uuid: string;
	title: string;
	isPublic: boolean;
	count: number;
}

export interface CatalogReader {
	listPlaylists(): Promise<PlaylistInfo[]>;
	readPlaylist(uuid: string): Promise<PlaylistSnapshot>;
	findByIsrc(isrc: string): Promise<Track[]>;
	search(query: string): Promise<Track[]>;
	/** Asks the stream endpoint itself. Undefined means that it could not tell, for instance on a network error. */
	canPlay(trackId: number): Promise<boolean | undefined>;
}

export type FindingStatus =
	/** A playable version exists. */
	| "replace"
	/** The playable version is already in this playlist, only the dead entry has to go. */
	| "already-present"
	/** Nothing matches strictly enough on TIDAL. */
	| "no-match"
	/** Flagged as dead but the check against the stream endpoint disagreed or failed, left alone. */
	| "unverified";

export interface Finding {
	index: number;
	dead: Track;
	status: FindingStatus;
	match?: Match;
}

export interface PlaylistScan extends PlaylistInfo {
	total: number;
	findings: Finding[];
}

export interface ScanProgress {
	playlist: string;
	current: number;
	total: number;
}

export interface ScanOptions {
	match?: MatchOptions;
	onProgress?: (progress: ScanProgress) => void;
	signal?: AbortSignal;
}

interface Resolution {
	verified: boolean;
	matches: Match[];
}

const firstWords = (title: string): string => title.replace(/[([].*$/, "").replace(/\s-\s.*$/, "").trim();

/** Looks a dead track up by ISRC first since it identifies the recording, the text search only runs when that finds nothing. */
const resolve = async (client: CatalogReader, dead: Track, options: MatchOptions): Promise<Resolution> => {
	if ((await client.canPlay(dead.id)) !== false) return { verified: false, matches: [] };

	let matches = options.isrc && dead.isrc ? rankMatches(dead, await client.findByIsrc(dead.isrc), { ...options, name: false }) : [];

	if (matches.length === 0 && options.name) {
		const artist = dead.artists?.[0]?.name ?? "";
		const found = await client.search(`${dead.title} ${artist}`);
		const short = firstWords(dead.title);
		if (short !== dead.title) found.push(...(await client.search(`${short} ${artist}`)));
		matches = rankMatches(dead, found, options);
	}

	const playable: Match[] = [];
	for (const match of matches) {
		if (await client.canPlay(match.track.id)) playable.push(match);
	}
	return { verified: true, matches: playable };
};

export const scanPlaylists = async (client: CatalogReader, playlists: PlaylistInfo[], { match = DEFAULT_MATCH_OPTIONS, onProgress, signal }: ScanOptions = {}): Promise<PlaylistScan[]> => {
	const scans: PlaylistScan[] = [];
	// The same dead track is often in several playlists.
	const resolutions = new Map<number, Promise<Resolution>>();

	for (let current = 0; current < playlists.length; current++) {
		if (signal?.aborted) break;
		const playlist = playlists[current];
		onProgress?.({ playlist: playlist.title, current, total: playlists.length });

		const { items } = await client.readPlaylist(playlist.uuid);
		const present = new Set(items.map((entry) => entry.item.id));
		const findings: Finding[] = [];

		for (let index = 0; index < items.length; index++) {
			if (signal?.aborted) break;
			const { type, item: dead } = items[index];
			if (type === "video" || !isDead(dead)) continue;

			if (!resolutions.has(dead.id)) resolutions.set(dead.id, resolve(client, dead, match));
			const { verified, matches } = await resolutions.get(dead.id)!;

			if (!verified) {
				findings.push({ index, dead, status: "unverified" });
				continue;
			}
			const existing = matches.find((m) => present.has(m.track.id));
			if (existing) {
				findings.push({ index, dead, status: "already-present", match: existing });
			} else if (matches.length > 0) {
				findings.push({ index, dead, status: "replace", match: matches[0] });
				// A second copy of the same dead track must not bring a duplicate along.
				present.add(matches[0].track.id);
			} else {
				findings.push({ index, dead, status: "no-match" });
			}
		}
		scans.push({ ...playlist, total: items.length, findings });
	}
	return scans;
};

/** Without a replacement the edit is a plain removal, Settings only preselects those whose song stays in the playlist. */
export const toEdit = (finding: Finding): PlaylistEdit => ({
	index: finding.index,
	deadId: finding.dead.id,
	replacementId: finding.status === "replace" ? finding.match?.track.id : undefined,
});

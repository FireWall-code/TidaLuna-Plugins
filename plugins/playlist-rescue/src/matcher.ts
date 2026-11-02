// Pure matching rules, free of any @luna import so that they can run under node:test.

export interface Track {
	id: number;
	title: string;
	version?: string | null;
	duration: number;
	isrc?: string | null;
	explicit?: boolean;
	allowStreaming?: boolean;
	streamReady?: boolean;
	upload?: boolean;
	audioQuality?: string;
	mediaMetadata?: { tags?: string[] };
	popularity?: number;
	artists?: { name: string }[];
	album?: { title?: string };
}

export type MatchKind = "isrc" | "metadata";

export interface MatchOptions {
	/** Accept the same recording, identified by its ISRC. */
	isrc: boolean;
	/** Accept the same title, artist and duration when no ISRC is shared. */
	name: boolean;
	/** Among acceptable versions: the one closest to the dead track, or the best audio quality. */
	prefer: "closest" | "quality";
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = { isrc: true, name: true, prefer: "closest" };

export interface Match {
	track: Track;
	kind: MatchKind;
	/** Same recording but listed under another title or artist, worth a look before applying. */
	metadataDiffers: boolean;
}

/** An ISRC identifies a recording, a larger gap than this means the code was reused for something else. */
const ISRC_MAX_DURATION_GAP = 5;
const METADATA_MAX_DURATION_GAP = 2;

const QUALITY_RANK: Record<string, number> = { LOW: 0, HIGH: 1, LOSSLESS: 2, HI_RES_LOSSLESS: 3 };

/** audioQuality says LOSSLESS for nearly everything, Hi-Res only shows up in the metadata tags. */
export const qualityOf = (track: Track): number =>
	Math.max(QUALITY_RANK[track.audioQuality ?? ""] ?? -1, track.mediaMetadata?.tags?.includes("HIRES_LOSSLESS") ? QUALITY_RANK.HI_RES_LOSSLESS : -1);

export const isPlayable = (track: Track): boolean => track.allowStreaming === true && track.streamReady === true;

/** Missing flags are not evidence, only an explicit false marks a track as dead. Uploads are the user's own files. */
export const isDead = (track: Track): boolean => !track.upload && (track.allowStreaming === false || track.streamReady === false);

export const normalize = (text: string): string =>
	text
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[([]\s*(feat|ft|with)\b[^)\]]*[)\]]/g, " ")
		.replace(/\b(feat|ft)\.?\s.*$/g, " ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

/** TIDAL stores "Slowed" either in the title or in the version field, this makes both forms comparable. */
export const fullTitle = (track: Pick<Track, "title" | "version">): string => {
	const title = normalize(track.title);
	const version = normalize(track.version ?? "");
	if (version === "" || title.endsWith(version)) return title;
	return `${title} ${version}`;
};

const artistNames = (track: Track): Set<string> => new Set((track.artists ?? []).map((a) => normalize(a.name)));

const sharesArtist = (a: Track, b: Track): boolean => {
	const names = artistNames(a);
	for (const name of artistNames(b)) if (names.has(name)) return true;
	return false;
};

const sameArtists = (a: Track, b: Track): boolean => {
	const namesA = artistNames(a);
	const namesB = artistNames(b);
	return namesA.size === namesB.size && [...namesA].every((name) => namesB.has(name));
};

const durationGap = (a: Track, b: Track): number => Math.abs(a.duration - b.duration);

const sameAlbum = (a: Track, b: Track): boolean => a.album?.title !== undefined && normalize(a.album.title) === normalize(b.album?.title ?? "");

const isIsrcMatch = (dead: Track, candidate: Track): boolean => {
	if (!dead.isrc || dead.isrc !== candidate.isrc) return false;
	if (durationGap(dead, candidate) > ISRC_MAX_DURATION_GAP) return false;
	// A shared code on an unrelated title by unrelated artists is a catalogue error rather than the same song.
	return sharesArtist(dead, candidate) || fullTitle(dead) === fullTitle(candidate);
};

const isMetadataMatch = (dead: Track, candidate: Track): boolean =>
	fullTitle(dead) === fullTitle(candidate) &&
	sharesArtist(dead, candidate) &&
	durationGap(dead, candidate) <= METADATA_MAX_DURATION_GAP &&
	// Without a shared ISRC this is what separates the original from its clean edit.
	Boolean(dead.explicit) === Boolean(candidate.explicit);

const rank = (dead: Track, prefer: MatchOptions["prefer"]) => (a: Track, b: Track) =>
	(prefer === "quality" ? qualityOf(b) - qualityOf(a) : 0) ||
	Number(sameAlbum(dead, b)) - Number(sameAlbum(dead, a)) ||
	Number(sameArtists(dead, b)) - Number(sameArtists(dead, a)) ||
	Number(Boolean(b.explicit) === Boolean(dead.explicit)) - Number(Boolean(a.explicit) === Boolean(dead.explicit)) ||
	durationGap(dead, a) - durationGap(dead, b) ||
	qualityOf(b) - qualityOf(a) ||
	(b.popularity ?? 0) - (a.popularity ?? 0) ||
	a.id - b.id;

/** Every acceptable replacement, best first. An empty list means no version of this song is available. */
export const rankMatches = (dead: Track, candidates: Track[], options: MatchOptions = DEFAULT_MATCH_OPTIONS): Match[] => {
	const byId = new Map<number, Track>();
	for (const candidate of candidates) if (candidate.id !== dead.id && isPlayable(candidate)) byId.set(candidate.id, candidate);
	const unique = [...byId.values()];
	const toMatch =
		(kind: MatchKind) =>
		(track: Track): Match => ({ track, kind, metadataDiffers: !sharesArtist(dead, track) || fullTitle(dead) !== fullTitle(track) });
	const byIsrc = options.isrc ? unique.filter((c) => isIsrcMatch(dead, c)) : [];
	const byName = options.name ? unique.filter((c) => !byIsrc.includes(c) && isMetadataMatch(dead, c)) : [];
	return [...byIsrc.sort(rank(dead, options.prefer)).map(toMatch("isrc")), ...byName.sort(rank(dead, options.prefer)).map(toMatch("metadata"))];
};

export interface PlaylistEdit {
	index: number;
	deadId: number;
	/** Undefined removes the dead track without inserting anything. */
	replacementId?: number;
}

/** Bottom first, so that an edit never shifts the index of the edits still to come. */
export const orderEdits = <T extends PlaylistEdit>(edits: T[]): T[] => [...edits].sort((a, b) => b.index - a.index);

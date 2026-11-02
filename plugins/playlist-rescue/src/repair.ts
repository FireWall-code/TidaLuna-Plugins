import { orderEdits, type PlaylistEdit, type Track } from "./matcher";

export interface PlaylistSnapshot {
	etag: string;
	items: { type?: string; item: Track }[];
}

/** TIDAL answered 412. Nothing was written, but the reason may be a real concurrent edit or just its own intermittent refusal. */
export class StaleEtagError extends Error {}

export interface PlaylistWriter {
	readPlaylist(uuid: string): Promise<PlaylistSnapshot>;
	/** Resolves to the new etag, throws when TIDAL did not actually add the track. */
	insertTrack(uuid: string, trackId: number, index: number, etag: string): Promise<string>;
	/** Resolves to the new etag. */
	removeIndex(uuid: string, index: number, etag: string): Promise<string>;
}

export interface FavoritesWriter {
	readPlaylist(uuid: string): Promise<PlaylistSnapshot>;
	addFavorite(trackId: number): Promise<void>;
	removeFavorite(trackId: number): Promise<void>;
}

export interface RepairReport {
	done: PlaylistEdit[];
	/** Set when the run stopped early, the edits that are not in `done` were left untouched. */
	error?: string;
}

export interface RepairOptions {
	onEdit?: (edit: PlaylistEdit) => void;
	maxConflicts?: number;
	conflictDelayMs?: number;
	/** How long the etag can keep moving after a burst of writes, the client must not reload the playlist before that. */
	settleDelayMs?: number;
	/** Checked between two edits, an edit that has started always completes. */
	signal?: AbortSignal;
}

const CANCELLED = "Cancelled: the remaining tracks were left untouched.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const changed = (edit: PlaylistEdit) => new Error(`The playlist changed since the scan (position ${edit.index + 1}), scan again.`);

const idAt = (snapshot: PlaylistSnapshot, index: number) => snapshot.items[index]?.item.id;

/**
 * Moves one edit forward from what the playlist holds right now, which is what makes it safe to resume after a 412:
 * dead track in place -> insert the replacement in front of it -> remove the dead track.
 * Returns false once the edit is complete. Anything unexpected at that position throws rather than guessing.
 */
const step = async (writer: PlaylistWriter, uuid: string, edit: PlaylistEdit, snapshot: PlaylistSnapshot, started: { value: boolean }): Promise<boolean> => {
	const { index, deadId, replacementId } = edit;
	const here = idAt(snapshot, index);

	if (replacementId === undefined) {
		if (here !== deadId) {
			if (started.value) return false;
			throw changed(edit);
		}
		started.value = true;
		snapshot.etag = await writer.removeIndex(uuid, index, snapshot.etag);
		snapshot.items.splice(index, 1);
		return false;
	}

	if (here === deadId) {
		started.value = true;
		snapshot.etag = await writer.insertTrack(uuid, replacementId, index, snapshot.etag);
		snapshot.items.splice(index, 0, { item: { id: replacementId, title: "", duration: 0 } });
		return true;
	}
	if (here === replacementId && idAt(snapshot, index + 1) === deadId) {
		started.value = true;
		snapshot.etag = await writer.removeIndex(uuid, index + 1, snapshot.etag);
		snapshot.items.splice(index + 1, 1);
		return false;
	}
	if (here === replacementId && started.value) return false;
	throw changed(edit);
};

/**
 * Applies edits one by one, always inserting before removing so that a failure can never lose a song.
 * Every write carries the etag of the previous one, which TIDAL refuses about 3 times out of 10 in a burst of writes (12 of 40
 * measured on 2026-11-02) because the stored value ends up a few hundred ms older than the one it returned. After a 412 the
 * playlist is read again and each edit checks its own position, so a real concurrent edit stops the run while a spurious refusal
 * only costs a retry.
 */
export const repairPlaylist = async (writer: PlaylistWriter, uuid: string, edits: PlaylistEdit[], options: RepairOptions = {}): Promise<RepairReport> => {
	const { onEdit, signal, maxConflicts = 6, conflictDelayMs = 500, settleDelayMs = 1500 } = options;
	let snapshot = await writer.readPlaylist(uuid);
	const done: PlaylistEdit[] = [];

	for (const edit of edits) {
		if (idAt(snapshot, edit.index) !== edit.deadId) return { done, error: changed(edit).message };
	}

	for (const edit of orderEdits(edits)) {
		if (signal?.aborted) {
			await sleep(settleDelayMs);
			return { done, error: CANCELLED };
		}
		const started = { value: false };
		let conflicts = 0;
		try {
			for (;;) {
				try {
					if (!(await step(writer, uuid, edit, snapshot, started))) break;
				} catch (err) {
					if (!(err instanceof StaleEtagError) || ++conflicts > maxConflicts) throw err;
					await sleep(conflictDelayMs * conflicts);
					snapshot = await writer.readPlaylist(uuid);
				}
			}
			done.push(edit);
			onEdit?.(edit);
		} catch (err) {
			await sleep(settleDelayMs);
			return { done, error: `Stopped at position ${edit.index + 1}: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	await sleep(settleDelayMs);
	const { items } = await writer.readPlaylist(uuid);
	const present = new Set(items.map((entry) => entry.item.id));
	const missing = done.filter((edit) => edit.replacementId !== undefined && !present.has(edit.replacementId));
	if (missing.length > 0) return { done, error: `Check failed: ${missing.length} replacement(s) missing from the playlist after writing.` };
	return { done };
};

/** Favorites have no position: the replacement is added with today's date, always before the dead track goes. */
export const repairFavorites = async (writer: FavoritesWriter, uuid: string, edits: PlaylistEdit[], { onEdit, signal }: RepairOptions = {}): Promise<RepairReport> => {
	const present = new Set((await writer.readPlaylist(uuid)).items.map((entry) => entry.item.id));
	const done: PlaylistEdit[] = [];
	for (const edit of edits) {
		if (signal?.aborted) return { done, error: CANCELLED };
		if (!present.has(edit.deadId)) return { done, error: `Track ${edit.deadId} is no longer in your favorites, scan again.` };
		try {
			if (edit.replacementId !== undefined) await writer.addFavorite(edit.replacementId);
			await writer.removeFavorite(edit.deadId);
			done.push(edit);
			onEdit?.(edit);
		} catch (err) {
			return { done, error: err instanceof Error ? err.message : String(err) };
		}
	}
	return { done };
};

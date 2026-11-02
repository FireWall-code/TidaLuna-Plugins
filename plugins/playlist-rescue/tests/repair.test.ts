// The fake reproduces what was measured on a real playlist on 2026-11-02: toIndex inserts, a stale etag gives 412, a write returns a new etag.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Track } from "../src/matcher";
import { repairFavorites, repairPlaylist, StaleEtagError, type FavoritesWriter, type PlaylistWriter } from "../src/repair";
import { scanPlaylists, toEdit, type CatalogReader, type PlaylistInfo } from "../src/scan";
import { chosenFindings, findingKey, preselect, summarize } from "../src/selection";

const FAST = { conflictDelayMs: 0, settleDelayMs: 0 };

const track = (id: number, title: string, isrc: string, playable = true): Track => ({
	id,
	title,
	isrc,
	duration: 100,
	artists: [{ name: "A" }],
	allowStreaming: playable,
	streamReady: playable,
});

class FakePlaylist implements PlaylistWriter {
	public version = 1;
	public failNextInsert = false;
	public failNextRemove = false;
	public calls: string[] = [];
	/** Indices of the writes that get a spurious 412, as measured on the real endpoint. */
	public spuriousConflicts = new Set<number>();
	private writes = 0;
	constructor(public ids: number[]) {}
	private check(etag: string) {
		if (this.spuriousConflicts.delete(this.writes++)) throw new StaleEtagError("HTTP 412");
		if (etag !== String(this.version)) throw new StaleEtagError("HTTP 412");
	}
	async readPlaylist() {
		return { etag: String(this.version), items: this.ids.map((id) => ({ type: "track", item: track(id, String(id), String(id)) })) };
	}
	async insertTrack(_: string, id: number, index: number, etag: string) {
		this.check(etag);
		if (this.failNextInsert) throw new Error("HTTP 500");
		this.calls.push(`insert ${id}@${index}`);
		this.ids.splice(index, 0, id);
		return String(++this.version);
	}
	async removeIndex(_: string, index: number, etag: string) {
		this.check(etag);
		if (this.failNextRemove) throw new Error("HTTP 500");
		this.calls.push(`remove @${index}`);
		this.ids.splice(index, 1);
		return String(++this.version);
	}
}

test("replacements keep their position, whatever their number", async () => {
	const playlist = new FakePlaylist([1, 2, 3, 4, 5]);
	const report = await repairPlaylist(playlist, "u", [
		{ index: 1, deadId: 2, replacementId: 20 },
		{ index: 3, deadId: 4, replacementId: 40 },
	], FAST);
	assert.deepEqual(playlist.ids, [1, 20, 3, 40, 5]);
	assert.equal(report.error, undefined);
	assert.equal(report.done.length, 2);
});

test("insertion happens before removal, and the bottom of the playlist goes first", async () => {
	const playlist = new FakePlaylist([1, 2, 3]);
	await repairPlaylist(playlist, "u", [
		{ index: 0, deadId: 1, replacementId: 10 },
		{ index: 2, deadId: 3, replacementId: 30 },
	], FAST);
	assert.deepEqual(playlist.calls, ["insert 30@2", "remove @3", "insert 10@0", "remove @1"]);
});

test("removal only: without replacement the track simply goes", async () => {
	const playlist = new FakePlaylist([1, 2, 3]);
	await repairPlaylist(playlist, "u", [{ index: 1, deadId: 2 }], FAST);
	assert.deepEqual(playlist.ids, [1, 3]);
});

test("nothing is written when a position no longer holds the expected track", async () => {
	const playlist = new FakePlaylist([1, 2, 3]);
	const report = await repairPlaylist(playlist, "u", [
		{ index: 2, deadId: 3, replacementId: 30 },
		{ index: 0, deadId: 999, replacementId: 10 },
	], FAST);
	assert.deepEqual(playlist.ids, [1, 2, 3]);
	assert.deepEqual(playlist.calls, []);
	assert.match(report.error!, /scan again/);
});

test("a refused insertion removes nothing", async () => {
	const playlist = new FakePlaylist([1, 2, 3]);
	playlist.failNextInsert = true;
	const report = await repairPlaylist(playlist, "u", [{ index: 1, deadId: 2, replacementId: 20 }], FAST);
	assert.deepEqual(playlist.ids, [1, 2, 3]);
	assert.deepEqual(report.done, []);
	assert.match(report.error!, /HTTP 500/);
});

test("a refused removal keeps both tracks and stops the run", async () => {
	const playlist = new FakePlaylist([1, 2, 3]);
	playlist.failNextRemove = true;
	const report = await repairPlaylist(playlist, "u", [
		{ index: 0, deadId: 1, replacementId: 10 },
		{ index: 2, deadId: 3, replacementId: 30 },
	], FAST);
	assert.deepEqual(playlist.ids, [1, 2, 30, 3]);
	assert.deepEqual(report.done, []);
	assert.ok(report.error);
});

test("a 412 that never clears gives up without writing anything", async () => {
	const playlist = new FakePlaylist([1, 2, 3]);
	const realRead = playlist.readPlaylist.bind(playlist);
	playlist.readPlaylist = async () => {
		const snapshot = await realRead();
		playlist.version++;
		return snapshot;
	};
	const report = await repairPlaylist(playlist, "u", [{ index: 1, deadId: 2, replacementId: 20 }], FAST);
	assert.deepEqual(playlist.ids, [1, 2, 3]);
	assert.match(report.error!, /412/);
});

test("a spurious 412 on any write is retried and the result is exact", async () => {
	for (const conflictAt of [0, 1, 2, 3]) {
		const playlist = new FakePlaylist([1, 2, 3]);
		playlist.spuriousConflicts.add(conflictAt);
		const report = await repairPlaylist(
			playlist,
			"u",
			[
				{ index: 0, deadId: 1, replacementId: 10 },
				{ index: 2, deadId: 3, replacementId: 30 },
			],
			FAST,
		);
		assert.equal(report.error, undefined, `write ${conflictAt}`);
		assert.deepEqual(playlist.ids, [10, 2, 30], `write ${conflictAt}`);
		assert.equal(report.done.length, 2);
	}
});

test("a removal without replacement survives a spurious 412", async () => {
	const playlist = new FakePlaylist([1, 2, 3]);
	playlist.spuriousConflicts.add(0);
	await repairPlaylist(playlist, "u", [{ index: 1, deadId: 2 }], FAST);
	assert.deepEqual(playlist.ids, [1, 3]);
});

test("a real edit made during the run stops it at the first position that no longer matches", async () => {
	const playlist = new FakePlaylist([1, 2, 3, 4]);
	playlist.spuriousConflicts.add(1);
	const realRemove = playlist.removeIndex.bind(playlist);
	let shifted = false;
	playlist.removeIndex = async (uuid, index, etag) => {
		if (!shifted) {
			// Someone adds a track at the top between the insert and the removal: every position moves down by one.
			shifted = true;
			playlist.ids.unshift(99);
			playlist.version++;
		}
		return realRemove(uuid, index, etag);
	};
	const report = await repairPlaylist(playlist, "u", [{ index: 2, deadId: 3, replacementId: 30 }], FAST);
	assert.deepEqual(playlist.ids, [99, 1, 2, 30, 3, 4], "both tracks stay, no wrong removal");
	assert.deepEqual(report.done, []);
	assert.match(report.error!, /scan again/);
});

test("cancelling keeps what is done and leaves the rest untouched", async () => {
	const playlist = new FakePlaylist([1, 2, 3]);
	const controller = new AbortController();
	const report = await repairPlaylist(
		playlist,
		"u",
		[
			{ index: 0, deadId: 1, replacementId: 10 },
			{ index: 2, deadId: 3, replacementId: 30 },
		],
		{ ...FAST, signal: controller.signal, onEdit: () => controller.abort() },
	);
	assert.deepEqual(playlist.ids, [1, 2, 30], "only the first edit, from the bottom, ran");
	assert.equal(report.done.length, 1);
	assert.match(report.error!, /Cancelled/);
});

class FakeFavorites implements FavoritesWriter {
	public failAdd = false;
	public failRemove = false;
	public calls: string[] = [];
	constructor(public ids: number[]) {}
	async readPlaylist() {
		return { etag: "", items: this.ids.map((id) => ({ item: track(id, String(id), String(id)) })) };
	}
	async addFavorite(id: number) {
		if (this.failAdd) throw new Error("HTTP 500");
		this.calls.push(`add ${id}`);
		this.ids.push(id);
	}
	async removeFavorite(id: number) {
		if (this.failRemove) throw new Error("HTTP 500");
		this.calls.push(`remove ${id}`);
		this.ids = this.ids.filter((x) => x !== id);
	}
}

test("favorites: the replacement is added before the dead track goes", async () => {
	const favorites = new FakeFavorites([1, 2]);
	const report = await repairFavorites(favorites, "f", [{ index: 0, deadId: 1, replacementId: 10 }]);
	assert.deepEqual(favorites.calls, ["add 10", "remove 1"]);
	assert.deepEqual(favorites.ids, [2, 10]);
	assert.equal(report.error, undefined);
});

test("favorites: a refused addition removes nothing", async () => {
	const favorites = new FakeFavorites([1, 2]);
	favorites.failAdd = true;
	const report = await repairFavorites(favorites, "f", [{ index: 0, deadId: 1, replacementId: 10 }]);
	assert.deepEqual(favorites.ids, [1, 2]);
	assert.deepEqual(report.done, []);
	assert.ok(report.error);
});

test("favorites: a track that left since the scan stops the run", async () => {
	const favorites = new FakeFavorites([2]);
	const report = await repairFavorites(favorites, "f", [{ index: 0, deadId: 1, replacementId: 10 }]);
	assert.deepEqual(favorites.calls, []);
	assert.match(report.error!, /scan again/);
});

const INFO: PlaylistInfo = { uuid: "u", title: "T", isPublic: false, count: 0 };

const catalog = (items: Track[], over: Partial<CatalogReader> = {}): CatalogReader => ({
	listPlaylists: async () => [INFO],
	readPlaylist: async () => ({ etag: "1", items: items.map((item) => ({ type: "track", item })) }),
	findByIsrc: async () => [],
	search: async () => [],
	canPlay: async () => false,
	...over,
});

test("scan: a dead track with an available ISRC is replaced, playable tracks are ignored", async () => {
	const dead = track(1, "Song", "X", false);
	const [scan] = await scanPlaylists(
		catalog([track(9, "Fine", "F"), dead], { findByIsrc: async () => [track(2, "Song", "X")], canPlay: async (id) => id === 2 }),
		[INFO],
	);
	assert.equal(scan.findings.length, 1);
	assert.equal(scan.findings[0].index, 1);
	assert.equal(scan.findings[0].status, "replace");
	assert.deepEqual(toEdit(scan.findings[0]), { index: 1, deadId: 1, replacementId: 2 });
});

test("scan: flags that disagree with the stream endpoint leave the track alone", async () => {
	const dead = track(1, "Song", "X", false);
	for (const answer of [true, undefined]) {
		const [scan] = await scanPlaylists(catalog([dead], { canPlay: async () => answer }), [INFO]);
		assert.equal(scan.findings[0].status, "unverified");
	}
});

test("scan: a candidate that the stream endpoint refuses is skipped for the next one", async () => {
	const dead = track(1, "Song", "X", false);
	const [scan] = await scanPlaylists(
		catalog([dead], { findByIsrc: async () => [track(2, "Song", "X"), track(3, "Song", "X")], canPlay: async (id) => id === 3 }),
		[INFO],
	);
	assert.equal(scan.findings[0].match?.track.id, 3);
});

test("scan: no replacement means no edit target, and the song is never proposed for silent removal", async () => {
	const dead = track(1, "Song", "X", false);
	const [scan] = await scanPlaylists(catalog([dead], { search: async () => [track(5, "Other", "Y")] }), [INFO]);
	assert.equal(scan.findings[0].status, "no-match");
	assert.equal(toEdit(scan.findings[0]).replacementId, undefined);
});

test("scan: a replacement already in the playlist only removes the dead entry", async () => {
	const dead = track(1, "Song", "X", false);
	const alive = track(2, "Song", "X");
	const [scan] = await scanPlaylists(catalog([dead, alive], { findByIsrc: async () => [alive], canPlay: async (id) => id === 2 }), [INFO]);
	assert.equal(scan.findings[0].status, "already-present");
	assert.equal(toEdit(scan.findings[0]).replacementId, undefined);
});

test("scan: two copies of a dead track do not create a duplicate", async () => {
	const dead = track(1, "Song", "X", false);
	const alive = track(2, "Song", "X");
	const [scan] = await scanPlaylists(catalog([dead, track(9, "Fine", "F"), dead], { findByIsrc: async () => [alive], canPlay: async (id) => id === 2 }), [INFO]);
	assert.deepEqual(
		scan.findings.map((f) => f.status),
		["replace", "already-present"],
	);
});

test("scan: a dead track shared by playlists is only looked up once", async () => {
	const dead = track(1, "Song", "X", false);
	let lookups = 0;
	await scanPlaylists(
		catalog([dead], {
			findByIsrc: async () => {
				lookups++;
				return [track(2, "Song", "X")];
			},
			canPlay: async (id) => id === 2,
		}),
		[INFO, { ...INFO, uuid: "v" }],
	);
	assert.equal(lookups, 1);
});

test("scan: videos and uploads are not treated as dead tracks", async () => {
	const upload = { ...track(1, "Mine", "X", false), upload: true };
	const client = catalog([upload]);
	const realRead = client.readPlaylist;
	client.readPlaylist = async (uuid) => {
		const snapshot = await realRead(uuid);
		snapshot.items.push({ type: "video", item: track(2, "Clip", "V", false) });
		return snapshot;
	};
	const [scan] = await scanPlaylists(client, [INFO]);
	assert.deepEqual(scan.findings, []);
});

test("options: name detection off runs no text search, ISRC off runs no ISRC lookup", async () => {
	const dead = track(1, "Song", "X", false);
	const seen: string[] = [];
	const client = catalog([dead], {
		findByIsrc: async () => {
			seen.push("isrc");
			return [];
		},
		search: async () => {
			seen.push("search");
			return [];
		},
	});
	await scanPlaylists(client, [INFO], { match: { isrc: true, name: false, prefer: "closest" } });
	assert.deepEqual(seen, ["isrc"]);
	seen.length = 0;
	await scanPlaylists(client, [INFO], { match: { isrc: false, name: true, prefer: "closest" } });
	assert.deepEqual(seen, ["search"]);
});

test("only the selected playlists are read", async () => {
	const read: string[] = [];
	const client = catalog([], {
		readPlaylist: async (uuid) => {
			read.push(uuid);
			return { etag: "1", items: [] };
		},
	});
	await scanPlaylists(client, [{ ...INFO, uuid: "picked" }]);
	assert.deepEqual(read, ["picked"]);
});

test("selection: unmatched tracks are only preselected under the remove policy", async () => {
	const [noMatch] = await scanPlaylists(catalog([track(1, "Song", "X", false)]), [INFO]);
	assert.equal(preselect([noMatch], "keep").size, 0);
	assert.equal(preselect([noMatch], "remove").size, 1);

	const [replace] = await scanPlaylists(catalog([track(1, "Song", "X", false)], { findByIsrc: async () => [track(2, "Song", "X")], canPlay: async (id) => id === 2 }), [INFO]);
	assert.equal(preselect([replace], "keep").size, 1);
});

test("selection: an unverified track can never be chosen, and the summary counts the rest", async () => {
	const [unverified] = await scanPlaylists(catalog([track(1, "Song", "X", false)], { canPlay: async () => undefined }), [INFO]);
	const forced = new Set([findingKey(unverified, unverified.findings[0])]);
	assert.deepEqual(chosenFindings(unverified, forced), []);
	assert.deepEqual(preselect([unverified], "remove").size, 0);

	const [mixed] = await scanPlaylists(
		catalog([track(1, "Song", "X", false), track(5, "Gone", "G", false)], { findByIsrc: async (isrc) => (isrc === "X" ? [track(2, "Song", "X")] : []), canPlay: async (id) => id === 2 }),
		[INFO],
	);
	assert.deepEqual(summarize([mixed], preselect([mixed], "remove")), { replaced: 1, removed: 1 });
	assert.deepEqual(summarize([mixed], preselect([mixed], "keep")), { replaced: 1, removed: 0 });
});

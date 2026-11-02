// Cases taken from a real scan: every title below was seen as dead on 2026-11-02.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fullTitle, isDead, isPlayable, normalize, orderEdits, qualityOf, rankMatches, type MatchOptions, type Track } from "../src/matcher";

const live = (id: number, title: string, artists: string[], duration: number, isrc: string, extra: Partial<Track> = {}): Track => ({
	id,
	title,
	duration,
	isrc,
	artists: artists.map((name) => ({ name })),
	allowStreaming: true,
	streamReady: true,
	audioQuality: "LOSSLESS",
	...extra,
});
const dead = (id: number, title: string, artists: string[], duration: number, isrc: string, extra: Partial<Track> = {}): Track => ({
	...live(id, title, artists, duration, isrc, extra),
	allowStreaming: false,
	streamReady: false,
});

test("flags: an unavailable track is dead, a playable or uploaded one is not", () => {
	assert.equal(isDead(dead(1, "JOKER", ["Dax"], 247, "X")), true);
	assert.equal(isDead(live(1, "JOKER", ["Dax"], 247, "X")), false);
	assert.equal(isDead({ ...dead(1, "Mine", ["Me"], 10, "X"), upload: true }), false);
	assert.equal(isDead({ id: 1, title: "No flags", duration: 1 }), false);
	assert.equal(isPlayable({ id: 1, title: "No flags", duration: 1 }), false);
});

test("JOKER - Dax is replaced by the same ISRC and not by JOKER RETURNS", () => {
	const track = dead(138967408, "JOKER", ["Dax"], 247, "USZHR2000022", { explicit: true });
	const matches = rankMatches(track, [
		live(159913677, "JOKER RETURNS", ["Dax"], 258, "USA2P2038584", { explicit: true }),
		live(478925149, "JOKER", ["Dax"], 247, "USZHR2000022", { explicit: true }),
		live(345575918, "Joker", ["Daxon B. Miller", "Kartel Murray"], 91, "QZ5AB2484469"),
	]);
	assert.deepEqual(
		matches.map((m) => [m.track.id, m.kind]),
		[[478925149, "isrc"]],
	);
	assert.equal(matches[0].metadataDiffers, false);
});

test("the dead id itself and other dead versions are never proposed", () => {
	const track = dead(1, "Song", ["A"], 100, "SAME");
	assert.deepEqual(rankMatches(track, [track, dead(2, "Song", ["A"], 100, "SAME")]), []);
});

test("the version from the same album wins when an ISRC exists twice", () => {
	const rain = dead(1, "Rain", ["oskar med k", "Marini"], 148, "AUMEV2313116", { album: { title: "No Clouds" } });
	const matches = rankMatches(rain, [
		live(532757296, "Rain", ["oskar med k", "Marini"], 148, "AUMEV2313116", { album: { title: "Rain" } }),
		live(532757302, "Rain", ["oskar med k", "Marini"], 148, "AUMEV2313116", { album: { title: "No Clouds" } }),
	]);
	assert.equal(matches[0].track.id, 532757302);

	const beberte = dead(2, "Beberte", ["Dyce", "SUSOBRINO"], 139, "QMFMF2378362", { album: { title: "Beberte" } });
	const beberteMatches = rankMatches(beberte, [
		live(356313434, "Beberte", ["SUSOBRINO", "Dyce"], 139, "QMFMF2378362", { album: { title: "SU" } }),
		live(563454272, "Beberte", ["Dyce", "SUSOBRINO"], 139, "QMFMF2378362", { album: { title: "Beberte" } }),
	]);
	assert.equal(beberteMatches[0].track.id, 563454272);
});

test("an ISRC match survives a translated title and is flagged for review", () => {
	const track = dead(1, "All For You", ["Стас Михайлов"], 234, "FR6V81484349");
	const [match] = rankMatches(track, [live(63475794, "Все для тебя", ["Стас Михайлов"], 234, "FR6V81484349")]);
	assert.equal(match.kind, "isrc");
	assert.equal(match.metadataDiffers, true);
});

test("an ISRC match survives a renamed artist and is flagged for review", () => {
	const track = dead(379720039, "Everything In Its Right Place", ["Alexandra Fever"], 100, "AUGBT2418672", { version: "Blurry Face Films" });
	const [match] = rankMatches(track, [live(406315637, "Everything In Its Right Place (Blurry Face Films)", ["Cloury"], 100, "AUGBT2418672")]);
	assert.equal(match.track.id, 406315637);
	assert.equal(match.metadataDiffers, true);
});

test("a shared ISRC on an unrelated song or another duration is refused", () => {
	const track = dead(1, "Song", ["A"], 100, "SAME");
	assert.deepEqual(rankMatches(track, [live(2, "Other", ["B"], 100, "SAME")]), []);
	assert.deepEqual(rankMatches(track, [live(3, "Song", ["A"], 160, "SAME")]), []);
});

test("different songs with a similar name are refused", () => {
	const fever = dead(1, "Everything In Its Right Place", ["Alexandra Fever"], 100, "AUGBT2418672");
	assert.deepEqual(rankMatches(fever, [live(58990524, "Everything In Its Right Place", ["Radiohead"], 251, "GBAYE0000810")]), []);

	const zone = dead(2, "Danger Zone", ["Zvri", "Kususa", "DJ Tira"], 204, "ZBWNK2200007", { version: "Radio Edit" });
	assert.deepEqual(rankMatches(zone, [live(5119939, "Danger Zone", ["Kenny Loggins"], 216, "USSM18600108")]), []);

	const walker = dead(3, "All For You", ["Стас Михайлов"], 234, "FR6V81484349");
	assert.deepEqual(rankMatches(walker, [live(2878902, "All For You", ["Janet Jackson"], 330, "USVI20100057")]), []);
});

test("without ISRC the same title, artist and duration is accepted", () => {
	const evaporado = dead(1, "Evaporado", ["Dyce"], 110, "QMFMF2302159");
	const [match] = rankMatches(evaporado, [live(563454258, "Evaporado", ["Dyce"], 110, "QZTVM2342732")]);
	assert.equal(match.kind, "metadata");

	const pepe = dead(2, "Don Pepe", ["LEBEEY"], 180, "QZWFR2348724");
	assert.equal(rankMatches(pepe, [live(508446237, "Don Pepe", ["Lebeey"], 180, "QZES82562279")])[0].track.id, 508446237);
});

test("without ISRC a remix, a slowed cut or a clean edit is refused", () => {
	const slowed = dead(1, "VAI SENTAR - Slowed", ["NEAR DEATH", "mc pl alves"], 87, "USANG2515701");
	assert.deepEqual(rankMatches(slowed, [live(2, "VAI SENTAR 2", ["NEAR DEATH"], 75, "RUAH62569431", { version: "Slowed" })]), []);

	const original = dead(3, "Intoxicated", ["Doruksen"], 309, "A");
	assert.deepEqual(rankMatches(original, [live(4, "Intoxicated", ["Doruksen"], 135, "B", { version: "Slowed" })]), []);

	const capaz = dead(5, "capaz (merengueton)", ["alleh", "Yorghaki"], 174, "USLD91766968");
	assert.deepEqual(rankMatches(capaz, [live(6, "capaz (merengueton) (8D Audio)", ["GALEX", "alleh"], 174, "GX8LD2584065")]), []);

	const explicit = dead(7, "Song", ["A"], 100, "A", { explicit: true });
	assert.deepEqual(rankMatches(explicit, [live(8, "Song", ["A"], 100, "B", { explicit: false })]), []);
});

test("an ISRC match is preferred over a metadata match", () => {
	const track = dead(1, "Song", ["A"], 100, "GOOD");
	const matches = rankMatches(track, [live(2, "Song", ["A"], 100, "OTHER", { audioQuality: "HI_RES_LOSSLESS" }), live(3, "Song", ["A"], 100, "GOOD")]);
	assert.deepEqual(
		matches.map((m) => m.track.id),
		[3, 2],
	);
});

test("options: each detection method can be switched off", () => {
	const track = dead(1, "Song", ["A"], 100, "GOOD");
	const candidates = [live(2, "Song", ["A"], 100, "OTHER"), live(3, "Song", ["A"], 100, "GOOD")];
	const ids = (options: MatchOptions) => rankMatches(track, candidates, options).map((m) => m.track.id);
	assert.deepEqual(ids({ isrc: true, name: false, prefer: "closest" }), [3]);
	assert.deepEqual(ids({ isrc: false, name: true, prefer: "closest" }), [3, 2].sort());
	assert.deepEqual(ids({ isrc: false, name: false, prefer: "closest" }), []);
});

test("options: quality can outrank the closest version, never across a different song", () => {
	const track = dead(1, "Song", ["A"], 100, "SAME", { album: { title: "Original" } });
	const sameAlbum = live(2, "Song", ["A"], 100, "SAME", { album: { title: "Original" } });
	const hiRes = live(3, "Song", ["A"], 100, "SAME", { album: { title: "Deluxe" }, mediaMetadata: { tags: ["LOSSLESS", "HIRES_LOSSLESS"] } });
	const otherSongHiRes = live(4, "Other", ["B"], 300, "DIFFERENT", { mediaMetadata: { tags: ["HIRES_LOSSLESS"] } });
	const ids = (prefer: MatchOptions["prefer"]) => rankMatches(track, [sameAlbum, hiRes, otherSongHiRes], { isrc: true, name: true, prefer }).map((m) => m.track.id);
	assert.deepEqual(ids("closest"), [2, 3]);
	assert.deepEqual(ids("quality"), [3, 2]);
});

test("Hi-Res is read from the metadata tags, audioQuality says LOSSLESS", () => {
	assert.equal(qualityOf(live(1, "S", ["A"], 1, "X", { mediaMetadata: { tags: ["LOSSLESS", "HIRES_LOSSLESS"] } })) > qualityOf(live(2, "S", ["A"], 1, "X")), true);
});

test("title normalisation handles version fields, accents and feat. mentions", () => {
	assert.equal(fullTitle({ title: "Intoxicated", version: "Slowed" }), fullTitle({ title: "Intoxicated (Slowed)" }));
	assert.equal(fullTitle({ title: "VAI SENTAR - Slowed" }), "vai sentar slowed");
	assert.equal(normalize("Ça tabasse"), "ca tabasse");
	assert.equal(normalize("Danger Zone (feat. DJ Tira) [Radio Edit]"), "danger zone radio edit");
	assert.equal(normalize("Song feat. Someone"), "song");
	assert.equal(normalize("Все для тебя"), "все для тебя");
});

test("edits run from the bottom of the playlist", () => {
	const edits = [{ index: 2, deadId: 1 }, { index: 19, deadId: 2 }, { index: 3, deadId: 3 }];
	assert.deepEqual(
		orderEdits(edits).map((e) => e.index),
		[19, 3, 2],
	);
	assert.equal(edits[0].index, 2);
});

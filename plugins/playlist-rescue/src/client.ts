import { redux, TidalApi } from "@luna/lib";

import type { Track } from "./matcher";
import { StaleEtagError, type FavoritesWriter, type PlaylistSnapshot, type PlaylistWriter } from "./repair";
import { FAVORITES_UUID, type CatalogReader, type PlaylistInfo } from "./scan";

const BASE = "https://desktop.tidal.com/v1";
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Write endpoints refuse the `fr-fr` locale that the client uses, they want `fr_FR`. */
const queryArgs = () => TidalApi.queryArgs().replace(/locale=([a-z]+)-([a-z]+)/i, (_, lang: string, region: string) => `locale=${lang.toLowerCase()}_${region.toUpperCase()}`);

/** Write endpoints answer 404 when `x-tidal-token` does not match the token's client id, so it is left out. */
const writeHeaders = async () => ({ Authorization: (await TidalApi.getAuthHeaders()).Authorization });

/** TidalApi.fetch is memoized, a scan has to see the current state of the playlist. */
const read = async (url: string): Promise<Response> => {
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(url, { headers: await TidalApi.getAuthHeaders(), cache: "no-store" });
			if (attempt >= 5 || (res.status !== 429 && res.status < 500)) return res;
			const retryAfter = Number(res.headers.get("Retry-After"));
			await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
		} catch (err) {
			if (attempt >= 3) throw err;
			await sleep(1000 * 2 ** attempt);
		}
	}
};

const readJson = async <T>(url: string): Promise<T> => {
	const res = await read(url);
	if (!res.ok) throw new Error(`TIDAL answered ${res.status} for ${url.split("?")[0]}`);
	return res.json();
};

/** Only 429 is retried: it guarantees that nothing happened, whereas a 5xx could have applied the write. */
const write = async (url: string, init: RequestInit): Promise<Response> => {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, init);
		if (res.status !== 429 || attempt >= 5) return res;
		const retryAfter = Number(res.headers.get("Retry-After"));
		await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
	}
};

const newEtag = (res: Response): string => {
	const etag = res.headers.get("etag");
	if (etag === null) throw new Error("TIDAL did not return an etag");
	return etag;
};

const describeFailure = async (res: Response): Promise<string> => {
	const body = await res.text().catch(() => "");
	return `HTTP ${res.status} ${body.slice(0, 200)}`;
};

const refused = async (action: string, res: Response): Promise<Error> => {
	const message = `${action} refused: ${await describeFailure(res)}`;
	return res.status === 412 ? new StaleEtagError(message) : new Error(message);
};

const userId = () => redux.store.getState().session.userId;

const readFavorites = async (): Promise<PlaylistSnapshot> => {
	const items: PlaylistSnapshot["items"] = [];
	for (let total = Infinity; items.length < total; ) {
		const page = await readJson<{ items?: PlaylistSnapshot["items"]; totalNumberOfItems: number }>(
			`${BASE}/users/${userId()}/favorites/tracks?${queryArgs()}&limit=1000&offset=${items.length}&order=DATE&orderDirection=ASC&_=${Date.now()}`,
		);
		if (!page.items?.length) break;
		total = page.totalNumberOfItems;
		items.push(...page.items);
	}
	return { etag: "", items };
};

export const tidalClient: CatalogReader & PlaylistWriter & FavoritesWriter & { favoritesInfo(): Promise<PlaylistInfo> } = {
	async listPlaylists(): Promise<PlaylistInfo[]> {
		const data = await readJson<{ items: { uuid: string; title: string; publicPlaylist?: boolean; numberOfTracks?: number; creator?: { id?: number } }[] }>(
			`${BASE}/users/${userId()}/playlists?${queryArgs()}&limit=999&_=${Date.now()}`,
		);
		return data.items
			.filter((p) => p.creator?.id === userId())
			.map((p) => ({ uuid: p.uuid, title: p.title, isPublic: p.publicPlaylist === true, count: p.numberOfTracks ?? 0 }))
			.sort((a, b) => a.title.localeCompare(b.title));
	},

	async favoritesInfo(): Promise<PlaylistInfo> {
		const { totalNumberOfItems } = await readJson<{ totalNumberOfItems: number }>(`${BASE}/users/${userId()}/favorites/tracks?${queryArgs()}&limit=1&_=${Date.now()}`);
		return { uuid: FAVORITES_UUID, title: "Favorites", isPublic: false, count: totalNumberOfItems };
	},

	async addFavorite(trackId: number): Promise<void> {
		const res = await write(`${BASE}/users/${userId()}/favorites/tracks?${queryArgs()}`, {
			method: "POST",
			headers: { ...(await writeHeaders()), ...FORM },
			body: `trackIds=${trackId}&onArtifactNotFound=FAIL`,
		});
		if (!res.ok) throw await refused("Add", res);
	},

	async removeFavorite(trackId: number): Promise<void> {
		const res = await write(`${BASE}/users/${userId()}/favorites/tracks/${trackId}?${queryArgs()}`, { method: "DELETE", headers: await writeHeaders() });
		if (!res.ok) throw await refused("Removal", res);
	},

	async readPlaylist(uuid: string): Promise<PlaylistSnapshot> {
		if (uuid === FAVORITES_UUID) return readFavorites();
		// The etag is read first: if the items change after this point the next write is refused with a 412.
		const meta = await read(`${BASE}/playlists/${uuid}?${queryArgs()}&_=${Date.now()}`);
		if (!meta.ok) throw new Error(`Cannot read the playlist: ${await describeFailure(meta)}`);
		const etag = newEtag(meta);
		const { items } = await readJson<{ items: PlaylistSnapshot["items"] }>(`${BASE}/playlists/${uuid}/items?${queryArgs()}&limit=-1&_=${Date.now()}`);
		return { etag, items };
	},

	async findByIsrc(isrc: string): Promise<Track[]> {
		const data = await readJson<{ items?: Track[] }>(`${BASE}/tracks?${queryArgs()}&isrc=${encodeURIComponent(isrc)}`);
		return data.items ?? [];
	},

	async search(query: string): Promise<Track[]> {
		const data = await readJson<{ items?: Track[] }>(`${BASE}/search/tracks?${queryArgs()}&query=${encodeURIComponent(query)}&limit=50`);
		return data.items ?? [];
	},

	async canPlay(trackId: number): Promise<boolean | undefined> {
		try {
			const res = await read(`${BASE}/tracks/${trackId}/playbackinfo?audioquality=LOSSLESS&playbackmode=STREAM&assetpresentation=FULL`);
			if (res.ok) return true;
			return res.status === 403 || res.status === 404 ? false : undefined;
		} catch {
			return undefined;
		}
	},

	async insertTrack(uuid: string, trackId: number, index: number, etag: string): Promise<string> {
		const res = await write(`${BASE}/playlists/${uuid}/items?${queryArgs()}`, {
			method: "POST",
			headers: { ...(await writeHeaders()), ...FORM, "If-None-Match": etag },
			body: `trackIds=${trackId}&onDupes=ADD&onArtifactNotFound=FAIL&toIndex=${index}`,
		});
		if (!res.ok) throw await refused("Add", res);
		const etagAfter = newEtag(res);
		const { addedItemIds } = (await res.json()) as { addedItemIds?: number[] };
		if (!addedItemIds?.includes(trackId)) throw new Error(`TIDAL answered OK without adding track ${trackId}`);
		return etagAfter;
	},

	async removeIndex(uuid: string, index: number, etag: string): Promise<string> {
		const res = await write(`${BASE}/playlists/${uuid}/items/${index}?${queryArgs()}`, {
			method: "DELETE",
			headers: { ...(await writeHeaders()), "If-None-Match": etag },
		});
		if (!res.ok) throw await refused("Removal", res);
		return newEtag(res);
	},
};

/**
 * The client keeps its own copy of a playlist and of its etag, its next edit would get a 412 without LOAD_PLAYLIST.
 * The playlist page and the sidebar read a separate RTK Query cache. Its endpoints are not exposed, but the action is matched by type alone.
 */
export const refreshClient = (uuid: string) => {
	if (uuid === FAVORITES_UUID) {
		redux.actions["content/LOAD_FAVORITE_TRACKS"]({ reset: true });
		redux.actions["content/LOAD_ALL_FAVORITES"]();
		return;
	}
	redux.actions["content/LOAD_PLAYLIST"]({ playlistUUID: uuid as redux.ItemId });
	redux.store.dispatch({ type: "tidalOpenPlatformApi/invalidateTags", payload: [{ type: "playlists" }, { type: "userCollectionPlaylists" }] });
};

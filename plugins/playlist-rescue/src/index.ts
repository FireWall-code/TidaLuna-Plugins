import { ReactiveStore, Tracer, type LunaUnload } from "@luna/core";

import { refreshClient, tidalClient } from "./client";
import type { JournalEntry } from "./journal";
import type { MatchOptions } from "./matcher";
import { repairFavorites, repairPlaylist } from "./repair";
import { scanPlaylists, toEdit } from "./scan";
import type { UnmatchedPolicy } from "./selection";

export const { trace, errSignal } = Tracer("[PlaylistRescue]");
export const unloads = new Set<LunaUnload>();

export const storage = await ReactiveStore.getPluginStorage<{
	journal: JournalEntry[];
	detectIsrc: boolean;
	detectName: boolean;
	prefer: MatchOptions["prefer"];
	unmatched: UnmatchedPolicy;
}>("PlaylistRescue", { journal: [], detectIsrc: true, detectName: true, prefer: "closest", unmatched: "keep" });

export { Settings } from "./Settings";

// Reachable from the debugger through luna.core.modules.
export const debugApi = { tidalClient, scanPlaylists, repairPlaylist, repairFavorites, refreshClient, toEdit };

import { searchIndex } from "../search.server.js";

/** The search index, prerendered into a file the search fetches on first use. */
export const loader = async () => Response.json(await searchIndex());

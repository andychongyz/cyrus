import { create } from "zustand";

interface ConnectionStore {
	apiKey: string;
	connected: boolean;
	setConnection: (apiKey: string) => void;
	disconnect: () => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
	apiKey: localStorage.getItem("cyrus_api_key") ?? "",
	connected: !!localStorage.getItem("cyrus_api_key"),
	setConnection: (apiKey) => {
		localStorage.setItem("cyrus_api_key", apiKey);
		set({ apiKey, connected: true });
	},
	disconnect: () => {
		localStorage.removeItem("cyrus_api_key");
		set({ apiKey: "", connected: false });
	},
}));

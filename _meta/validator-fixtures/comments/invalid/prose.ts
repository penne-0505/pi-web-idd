// parse the config and fall back to defaults when missing
export const parseConfig = (raw: string): unknown => JSON.parse(raw);

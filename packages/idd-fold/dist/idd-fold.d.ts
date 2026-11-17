import type * as MoonBit from "./moonbit.d.ts";

export function lane_answer(op: MoonBit.String,
                            ids: MoonBit.String,
                            args: MoonBit.String): MoonBit.Result<MoonBit.String, any>;

export function review_events_json(): MoonBit.String;

export function fold_records(ids: MoonBit.String,
                             viewer: MoonBit.String,
                             states: MoonBit.String): MoonBit.Result<MoonBit.String, any>;

export function lane_states(ids: MoonBit.String): MoonBit.Result<MoonBit.String, any>;

export function put_intent(text: MoonBit.String): MoonBit.Result<MoonBit.Unit, any>;

export function put_lifecycle(text: MoonBit.String): MoonBit.Result<MoonBit.Unit, any>;

export function depth_table_json(): MoonBit.String;

import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * Columns are epoch milliseconds; contracts carry ISO instants. Rows decode in one step, so the
 * repositories never hand a raw number to a caller.
 */
export const EpochMillis = Schema.Number.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (millis) => DateTime.formatIso(DateTime.makeUnsafe(millis)),
      encode: (instant) => Date.parse(instant),
    }),
  ),
);
export type EpochMillis = Schema.Schema.Type<typeof EpochMillis>;

export const NullableEpochMillis = Schema.NullOr(EpochMillis);
export type NullableEpochMillis = Schema.Schema.Type<typeof NullableEpochMillis>;

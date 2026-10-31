import { z } from 'zod';

// Not exported from index.ts. The two helpers below hold the only casts in the package.

/** `Object.keys` that keeps the literal key type. Sound only for const tables this package owns. */
export function keysOf<T extends object>(table: T): Array<keyof T & string> {
  return Object.keys(table) as Array<keyof T & string>;
}

/** `[T, ...T[]]`: a proposal names at least one obligation, a defaulter list is never empty. */
export const nonEmpty = <T extends z.ZodType>(item: T) => z.tuple([item], item);

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * The TypeScript side of a tagged union built from a record of payload shapes:
 * one member per key, the key as the `type` literal, the shape's fields flattened in.
 */
export type Flat<Shapes extends Record<string, z.ZodObject>> = {
  [K in keyof Shapes & string]: Simplify<{ type: K } & z.infer<Shapes[K]>>;
}[keyof Shapes & string];

/**
 * One zod discriminated union from one record. The record is the single source of truth for the
 * member list: `keysOf(record)` is the runtime list of types, `Flat<typeof record>` the static one.
 * `wrap` decides what each member looks like on the wire (flat for actions, enveloped for events).
 */
export function taggedUnion<U, Shapes extends Record<string, z.ZodObject>>(
  shapes: Shapes,
  wrap: (type: keyof Shapes & string, shape: Shapes[keyof Shapes & string]) => z.ZodObject,
): z.ZodType<U> {
  const options = keysOf(shapes).map((type) => wrap(type, shapes[type]));
  // zod cannot prove the built union matches the mapped type, so this one place asserts it.
  // schema.test.ts parses a fixture for every key, which is what keeps the assertion honest.
  return z.discriminatedUnion(
    'type',
    options as [z.ZodObject, ...z.ZodObject[]],
  ) as unknown as z.ZodType<U>;
}

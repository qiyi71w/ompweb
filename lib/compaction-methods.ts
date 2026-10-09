/** omp's `compaction.methodOrder` choices, in its settings-menu order
 * (coding-agent session/compaction-methods.ts COMPACTION_METHOD_CHOICES). */
export const COMPACTION_METHODS = ["remote", "snapcompact", "handoff", "soft", "shake"] as const;
export type CompactionMethod = (typeof COMPACTION_METHODS)[number];

function isCompactionMethod(value: unknown): value is CompactionMethod {
  return (COMPACTION_METHODS as readonly unknown[]).includes(value);
}

/** Known methods, no duplicates. Empty is valid: omp then runs no automatic compaction. */
export function isCompactionMethodOrder(value: unknown): value is CompactionMethod[] {
  return Array.isArray(value) && value.every(isCompactionMethod) && new Set(value).size === value.length;
}


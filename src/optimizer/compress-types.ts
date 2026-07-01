// Cladding · Token Optimizer · shared compression types
//
// These two shapes are shared by the seam (headroom.ts) and the native engine
// (compress-native.ts). They live in their own leaf module so neither imports
// the other — keeping the dependency graph acyclic. headroom.ts re-exports
// them, so existing `from './headroom.js'` imports keep working.

/** A chat message in OpenAI shape — the compressor's lingua franca. */
export interface OpenAIMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly tool_call_id?: string;
}

/** The result of one compression pass. */
export interface CompressResult {
  readonly messages: OpenAIMessage[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly tokensSaved: number;
  readonly compressionRatio: number;
  readonly transformsApplied: string[];
  readonly ccrHashes: string[];
  /** false ⇒ the pass produced no savings (treated as a no-op). */
  readonly compressed: boolean;
}

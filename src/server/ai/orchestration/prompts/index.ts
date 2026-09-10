/**
 * Registered prompts.
 *
 * Importing this module is what puts prompts into the registry, so anything
 * that enumerates prompts — the operator console, a version audit — imports
 * from here rather than reaching into individual files.
 */
export { assetAnalysisPrompt } from "./asset-analysis";
export type { AssetAnalysisInput, AssetAnalysisOutput } from "./asset-analysis";
export { copyVariantsPrompt } from "./copy-variants";
export type { CopyVariant, CopyVariantsInput, CopyVariantsOutput } from "./copy-variants";
export { strategyDraftPrompt, strategyDraftSchema } from "./strategy-draft";
export type { StrategyDraftInput, StrategyDraftOutput } from "./strategy-draft";

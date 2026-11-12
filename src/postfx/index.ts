/** The lo-fi post-processing chain: settings, offline render, master stage. */
export * from './settings';
export * from './constants';
export { buildRoomIR } from './room';
export { buildHiss, effectiveHissDb } from './hiss';
export { limitInPlace, masterInPlace, type LimitResult, type MasterOptions, type MasterReport } from './master';
export {
  planWobble,
  renderPostFx,
  sideOverMidDb,
  type PostFxDeps,
  type PostFxInput,
  type PostFxReport,
  type PostFxResult,
} from './chain';

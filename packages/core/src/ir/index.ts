/**
 * Public surface of the `@codegraph/core` IR module.
 *
 * Consumers should prefer the subpath import:
 *
 *   import type { IR, Node, Edge, Leaf, Sink } from '@codegraph/core/ir';
 *
 * The same symbols are also re-exported from the package root
 * (`@codegraph/core`) for convenience.
 *
 * Everything here is a re-export — no runtime logic lives in this barrel.
 * The canonical definitions live in `./types.ts`.
 */

export type {
  // Top level
  IRDocument,
  SchemaVersion,
  IR,
  Metadata,
  GeneratorInfo,
  Diagnostic,

  // Identity & shared primitives
  NodeId,
  Lang,
  TypeRef,
  StructuralType,
  StructuralField,
  SourceLoc,

  // Node tier & union variants
  NodeTier,
  Tier,
  ServiceNode,
  ModuleNode,
  TypeNode,
  TypeKind,
  TypeFieldDecl,
  FunctionNode,
  FunctionKind,
  FunctionParam,
  ExpressionNode,
  UnknownTierNode,
  Node,

  // Leaves
  LeafFlavor,
  LeafLiteral,
  LeafEnv,
  LeafConfigFile,
  ConfigFormat,
  LeafCliArg,
  LeafHttpInput,
  HttpInputFrom,
  LeafDbRead,
  LeafExternalApi,
  LeafUnknown,
  Leaf,

  // Sinks
  SinkFlavor,
  SinkDbWrite,
  SinkNetwork,
  SinkFs,
  SinkExec,
  SinkLog,
  SinkUnknown,
  Sink,

  // Edges
  EdgeCategory,
  CallEdge,
  ImportEdge,
  TypeFlowEdge,
  HttpRouteEdge,
  DbReadEdge,
  DbWriteEdge,
  EnvReadEdge,
  FsReadEdge,
  FsWriteEdge,
  NetworkEdge,
  ExecEdge,
  UnknownEdge,
  Edge,
} from "./types.js";

export {
  // Brand helper
  asNodeId,

  // Node guards
  isServiceNode,
  isModuleNode,
  isTypeNode,
  isFunctionNode,
  isExpressionNode,
  isUnknownTierNode,

  // Edge guards
  isCallEdge,
  isImportEdge,
  isTypeFlowEdge,
  isHttpRouteEdge,
  isDbReadEdge,
  isDbWriteEdge,
  isEnvReadEdge,
  isFsReadEdge,
  isFsWriteEdge,
  isNetworkEdge,
  isExecEdge,
  isUnknownEdge,

  // Leaf guards
  isLeafLiteral,
  isLeafEnv,
  isLeafConfigFile,
  isLeafCliArg,
  isLeafHttpInput,
  isLeafDbRead,
  isLeafExternalApi,
  isLeafUnknown,

  // Sink guards
  isSinkDbWrite,
  isSinkNetwork,
  isSinkFs,
  isSinkExec,
  isSinkLog,
  isSinkUnknown,

  // Closed-set predicates
  isKnownEdgeCategory,
  isKnownTier,
  isKnownLeafFlavor,
  isKnownSinkFlavor,

  // Constants
  SCHEMA_VERSION,
  KNOWN_EDGE_CATEGORIES,
  KNOWN_TIERS,
  KNOWN_LEAF_FLAVORS,
  KNOWN_SINK_FLAVORS,
} from "./types.js";

/**
 * Business context: identifies bounded experimental routing providers whose
 * installed cells cover only part of Switzerland. The Worker may ignore missing
 * halo cells when at least one requested corridor cell is covered, but it must
 * still distinguish a completely out-of-region request from an ordinary empty
 * swissTLM3D cell.
 */

/** Base error for a routing-cell request outside an installed data region. */
export class RoutingCoverageError extends Error {
  /** Provider-specific name retained across Worker serialization. */
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** Returns whether an unknown failure represents bounded-provider coverage. */
export function isRoutingCoverageError(
  error: unknown,
): error is RoutingCoverageError {
  return error instanceof RoutingCoverageError;
}

/**
 * Business context: reconstructs an A* node chain from predecessor links while
 * protecting the routing Worker from stale, cyclic, or out-of-range state. Both
 * the typed-array national graph and the GeoAdmin reference graph use this
 * guard before converting a route into display coordinates.
 */

/** Resolves the predecessor of one graph node, or `undefined` at the route root. */
export type PreviousRouteNodeLookup = (nodeId: number) => number | undefined;

/**
 * Reconstructs one root-to-goal graph-node path from predecessor links.
 *
 * A valid predecessor chain cannot contain more nodes than the graph itself.
 * Bounding the traversal turns an otherwise possible infinite Worker loop into
 * an explicit provider failure that the existing fallback policy can handle.
 *
 * @param goalNodeId - Destination graph node selected by A*.
 * @param nodeCount - Number of nodes in the assembled graph.
 * @param previousNode - Lookup returning the predecessor of a graph node.
 * @returns Node identifiers ordered from the route root to the destination.
 * @throws {Error} If a node identifier is invalid or the chain is cyclic.
 */
export function reconstructRouteNodePath(
  goalNodeId: number,
  nodeCount: number,
  previousNode: PreviousRouteNodeLookup,
): number[] {
  if (!Number.isInteger(nodeCount) || nodeCount <= 0) {
    throw new Error('Routing predecessor reconstruction requires graph nodes.');
  }

  const reversedPath: number[] = [];
  let nodeId: number | undefined = goalNodeId;

  while (nodeId !== undefined) {
    if (
      !Number.isInteger(nodeId) ||
      nodeId < 0 ||
      nodeId >= nodeCount
    ) {
      throw new Error(
        'Routing predecessor chain references an invalid graph node.',
      );
    }

    if (reversedPath.length >= nodeCount) {
      throw new Error(
        'Routing predecessor chain is cyclic or exceeds the graph size.',
      );
    }

    reversedPath.push(nodeId);
    nodeId = previousNode(nodeId);
  }

  reversedPath.reverse();
  return reversedPath;
}

/**
 * Copyright (c) 2017, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

import { isAsyncIterable } from 'iterall';
import {
  addPath,
  buildExecutionContext,
  collectFields,
  defaultFieldResolver,
  execute,
  getFieldDef,
  getOperationRootType,
  buildResolveInfo,
  resolveFieldValueOrError,
} from '../execution/execute';
import { GraphQLSchema } from '../type/schema';
import invariant from '../jsutils/invariant';
import mapAsyncIterator from './mapAsyncIterator';

import type { ExecutionResult } from '../execution/execute';
import type { DocumentNode } from '../language/ast';

/**
 * Implements the "Subscribe" algorithm described in the GraphQL specification.
 *
 * Returns an AsyncIterator
 *
 * If the arguments to this function do not result in a legal execution context,
 * a GraphQLError will be thrown immediately explaining the invalid input.
 */
export function subscribe(
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: mixed,
  contextValue?: mixed,
  variableValues?: ?{[key: string]: mixed},
  operationName?: ?string,
): AsyncIterator<ExecutionResult> {
  const subscription = createSourceEventStream(
    schema,
    document,
    rootValue,
    contextValue,
    variableValues,
    operationName);

  // For each payload yielded from a subscription, map it over the normal
  // GraphQL `execute` function, with `payload` as the rootValue.
  // This implements the "MapSourceToResponseEvent" algorithm described in
  // the GraphQL specification. The `execute` function provides the
  // "ExecuteSubscriptionEvent" algorithm, as it is nearly identical to the
  // "ExecuteQuery" algorithm, for which `execute` is also used.
  return mapAsyncIterator(
    subscription,
    payload => execute(
      schema,
      document,
      payload,
      contextValue,
      variableValues,
      operationName
    )
  );
}

/**
 * Implements the "CreateSourceEventStream" algorithm described in the
 * GraphQL specification, resolving the subscription source event stream.
 *
 * Returns an AsyncIterable, may through a GraphQLError.
 *
 * A Source Stream represents the sequence of events, each of which is
 * expected to be used to trigger a GraphQL execution for that event.
 *
 * This may be useful when hosting the stateful subscription service in a
 * different process or machine than the stateless GraphQL execution engine,
 * or otherwise separating these two steps. For more on this, see the
 * "Supporting Subscriptions at Scale" information in the GraphQL specification.
 */
export function createSourceEventStream(
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: mixed,
  contextValue?: mixed,
  variableValues?: ?{[key: string]: mixed},
  operationName?: ?string,
): AsyncIterable<mixed> {
  // If a valid context cannot be created due to incorrect arguments,
  // this will throw an error.
  const exeContext = buildExecutionContext(
    schema,
    document,
    rootValue,
    contextValue,
    variableValues,
    operationName
  );

  const type = getOperationRootType(schema, exeContext.operation);
  const fields = collectFields(
    exeContext,
    type,
    exeContext.operation.selectionSet,
    Object.create(null),
    Object.create(null)
  );
  const responseNames = Object.keys(fields);
  invariant(
    responseNames.length === 1,
    'A subscription operation must contain exactly one root field.'
  );
  const responseName = responseNames[0];
  const fieldNodes = fields[responseName];
  const fieldNode = fieldNodes[0];
  const fieldDef = getFieldDef(schema, type, fieldNode.name.value);
  invariant(
    fieldDef,
    'This subscription is not defined by the schema.'
  );

  // Call the `subscribe()` resolver or the default resolver to produce an
  // AsyncIterable yielding raw payloads.
  const resolveFn = fieldDef.subscribe || defaultFieldResolver;

  const info = buildResolveInfo(
    exeContext,
    fieldDef,
    fieldNodes,
    type,
    addPath(undefined, responseName)
  );

  // resolveFieldValueOrError implements the "ResolveFieldEventStream"
  // algorithm from GraphQL specification. It differs from
  // "ResolveFieldValue" due to providing a different `resolveFn`.
  const subscription = resolveFieldValueOrError(
    exeContext,
    fieldDef,
    fieldNodes,
    resolveFn,
    rootValue,
    info
  );

  if (subscription instanceof Error) {
    throw subscription;
  }

  invariant(
    isAsyncIterable(subscription),
    'Subscription must return Async Iterable.'
  );

  return (subscription: any);
}

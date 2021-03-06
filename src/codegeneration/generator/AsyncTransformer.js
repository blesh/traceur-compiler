// Copyright 2012 Traceur Authors.
//
// Licensed under the Apache License, Version 2.0 (the 'License');
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an 'AS IS' BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {AwaitState} from './AwaitState';
import {CPSTransformer} from './CPSTransformer';
import {EndState} from './EndState';
import {FallThroughState} from './FallThroughState';
import {STATE_MACHINE} from '../../syntax/trees/ParseTreeType';
import {
  parseExpression,
  parseStatement,
  parseStatements
} from '../PlaceholderParser';
import {State} from './State';
import {StateMachine} from '../../syntax/trees/StateMachine';
import {VAR} from '../../syntax/TokenType';
import {
  createAssignStateStatement,
  createBreakStatement,
  createReturnStatement,
  createStatementList,
  createUndefinedExpression
} from '../ParseTreeFactory';

/**
 * Desugars async function bodies. Async function bodies contain 'async' statements.
 *
 * At the top level the state machine is translated into this source code:
 *
 * {
 *   machine variables
 *   return $traceurRuntime.asyncWrap(machineFunction);
 * }
 */
export class AsyncTransformer extends CPSTransformer {
  /**
   * Yield statements are translated into a state machine with a single state.
   * @param {YieldExpression} tree
   * @return {ParseTree}
   */
  transformYieldExpression(tree) {
    this.reporter.reportError(tree.location.start,
        'Async function may not have a yield expression.');
    return tree;
  }

  /**
   * @param {AwaitStatement} tree
   * @return {ParseTree}
   */
  transformAwaitStatement(tree) {
    var createTaskState = this.allocateState();
    var callbackState = this.allocateState();
    var errbackState = this.allocateState();
    var fallThroughState = this.allocateState();

    var states = [];
    var expression = this.transformAny(tree.expression);
    //  case createTaskState:
    states.push(new AwaitState(createTaskState, callbackState, errbackState,
                               expression));

    //  case callbackState:
    //    identifier = $ctx.value;
    //    $ctx.state = fallThroughState;
    //    break;
    var assignment;
    if (tree.identifier != null)
      assignment = parseStatements `${tree.identifier} = $ctx.value`;
    else
      assignment = createStatementList();

    states.push(new FallThroughState(callbackState, fallThroughState, assignment));
    //  case errbackState:
    //    throw $ctx.err;
    states.push(new FallThroughState(errbackState, fallThroughState, createStatementList(
        parseStatement `throw $ctx.err`)));

    return new StateMachine(createTaskState, fallThroughState, states, []);
  }

  /**
   * @param {Finally} tree
   * @return {ParseTree}
   */
  transformFinally(tree) {
    var result = super.transformFinally(tree);
    if (result.block.type != STATE_MACHINE) {
      return result;
    }
    // TODO: is this a reasonable restriction?
    this.reporter.reportError(tree.location.start,
        'await not permitted within a finally block.');
    return result;
  }

  /**
   * @param {ReturnStatement} tree
   * @return {ParseTree}
   */
  transformReturnStatement(tree) {
    var result = tree.expression;
    if (result == null) {
      result = createUndefinedExpression();
    }
    var startState = this.allocateState();
    var endState = this.allocateState();
    var completeState = new FallThroughState(startState, endState,
        // $ctx.result.callback(result);
        createStatementList(this.createCompleteTask_(result)));
    var end = new EndState(endState);
    return new StateMachine(
        startState,
        // TODO: this should not be required, but removing requires making consumers resilient
        // TODO: to INVALID fallThroughState
        this.allocateState(),
        [completeState, end],
        []);
  }

  /**
   * @param {ParseTree} tree
   * @return {ParseTree}
   */
  createCompleteTask_(result) {
    return parseStatement `$ctx.resolve(${result})`;
  }

  /**
   * Transform an async function body - removing async statements.
   * The transformation is in two stages. First the statements are converted into a single
   * state machine by merging state machines via a bottom up traversal.
   *
   * Then the final state machine is converted into the following code:
   *
   * {
   *   machine variables
   *   return $traceurRuntime.asyncWrap(machineFunction);
   * }
   * @param {FunctionBody} tree
   * @return {FunctionBody}
   */
  transformAsyncBody(tree) {
    var runtimeFunction = parseExpression `$traceurRuntime.asyncWrap`;
    return this.transformCpsFunctionBody(tree, runtimeFunction);
  }

  /** @return {Array.<ParseTree>} */
  machineEndStatements() {
    // return;
    return createStatementList(createReturnStatement(null));
  }

  /**
   * @param {number} machineEndState
   * @return {Array.<ParseTree>}
   */
  machineFallThroughStatements(machineEndState) {
    // $ctx.waitTask.callback(undefined);
    // $ctx.state = machineEndState;
    // break;
    return createStatementList(
        this.createCompleteTask_(createUndefinedExpression()),
        createAssignStateStatement(machineEndState),
        createBreakStatement());
  }

  /**
   * @param {number} machineEndState
   * @return {Array.<ParseTree>}
   */
  machineRethrowStatements(machineEndState) {
    return createStatementList(
        parseStatement `$ctx.reject($ctx.storedException)`,
        // $ctx.state = machineEndState
        createAssignStateStatement(machineEndState),
        // break;
        createBreakStatement());
  }

  /**
   * @param {UniqueIdentifierGenerator} identifierGenerator
   * @param {ErrorReporter} reporter
   * @param {Block} body
   * @return {Block}
   */
  static transformAsyncBody(identifierGenerator, reporter, body) {
    return new AsyncTransformer(identifierGenerator, reporter).
        transformAsyncBody(body);
  }
};

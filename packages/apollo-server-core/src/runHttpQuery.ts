import { parse, getOperationAST, DocumentNode, formatError, ExecutionResult } from 'graphql';
import { runQuery } from './runQuery';
import { default as GraphQLOptions, resolveGraphqlOptions } from './graphqlOptions';

export interface HttpQueryRequest {
  method: string;
  query: [HttpQueryRequestQuery];
  options: GraphQLOptions | Function;
}

export interface HttpQueryRequestQuery {
  operationName: string;
  query: string | DocumentNode;
  variables: HttpQueryRequestQueryVariables;
}

export interface HttpQueryRequestQueryVariables {
  [key: string]: string | string[];
}

export class HttpQueryError extends Error {
  public statusCode: number;
  public isGraphQLError: boolean;
  public headers: { [key: string]: string };

  constructor(statusCode: number, message: string, isGraphQLError: boolean = false, headers?: { [key: string]: string }) {
    super(message);
    this.name = 'HttpQueryError';
    this.statusCode = statusCode;
    this.isGraphQLError = isGraphQLError;
    this.headers = headers;
  }
}

function isQueryOperation(query: DocumentNode, operationName: string) {
  const operationAST = getOperationAST(query, operationName);
  return operationAST.operation === 'query';
}
function isMutationOperation(query: DocumentNode, operationName: string) {
  const operationAST = getOperationAST(query, operationName);
  return operationAST.operation === 'query';
}

export async function runHttpQuery(handlerArguments: Array<any>, request: HttpQueryRequest): Promise<string> {
  let isGetRequest: boolean = false;
  let optionsObject: GraphQLOptions;

  try {
    optionsObject = await resolveGraphqlOptions(request.options, ...handlerArguments);
  } catch (e) {
    throw new HttpQueryError(500, e.message);
  }
  const formatErrorFn = optionsObject.formatError || formatError;
  let requestPayload: [HttpQueryRequestQuery];

  switch (request.method) {
    case 'POST':
      if (!request.query) {
        throw new HttpQueryError(500, 'POST body missing. Did you forget use body-parser middleware?');
      }

      requestPayload = request.query;
      break;
    case 'GET':
      if (!request.query || (Object.keys(request.query).length === 0)) {
        throw new HttpQueryError(400, 'GET query missing.');
      }

      isGetRequest = true;
      requestPayload = request.query;
      break;

    default:
      throw new HttpQueryError(405, 'Apollo Server supports only GET/POST requests.', false, {
        'Allow': 'GET, POST',
      });
  }

  let isBatch = true;
  // TODO: do something different here if the body is an array.
  // Throw an error if body isn't either array or object.
  if (!Array.isArray(requestPayload)) {
    isBatch = false;
    requestPayload = [requestPayload];
  }

  const responses = new Array<ExecutionResult>(requestPayload.length);
  const serialOperations = new Set<number>();
  const parallelOperations = new Set<number>();

  requestPayload.map((requestParams, index) => {
    let query = requestParams.query;
    if (isGetRequest) {
      if (typeof query === 'string') {
        // preparse the query incase of GET so we can assert the operation.
        query = parse(query);
      }

      if (isMutationOperation(query, requestParams.operationName)) {
        serialOperations.add(index);
      } else {
        parallelOperations.add(index);
      }
    }
  });

  for (const val of Array.from(serialOperations.values())) {
    responses[val] = await getQueryResult(requestPayload[val], isGetRequest, isBatch, formatError, optionsObject);
  }

  const res = await Promise.all(
    Array.from(
      parallelOperations.values()).map(
      idx => getQueryResult(requestPayload[idx], isGetRequest, isBatch, formatError, optionsObject),
    ));

  res.map((val, index) => {
    //parallelOperations[index] contains the actual array index
    const arrayIndex = parallelOperations[index];
    responses[arrayIndex] = val;
  });

  if (!isBatch) {
    const gqlResponse = responses[0];
    if (gqlResponse.errors && typeof gqlResponse.data === 'undefined') {
      throw new HttpQueryError(400, JSON.stringify(gqlResponse), true, {
        'Content-Type': 'application/json',
      });
    }
    return JSON.stringify(gqlResponse);
  }

  return JSON.stringify(responses);
}

function getQueryResult(
  requestParams: HttpQueryRequestQuery,
  isGetRequest: boolean,
  isBatch: boolean,
  formatErrorFn: Function,
  optionsObject: GraphQLOptions) {
  try {
    let query = requestParams.query;
    if (isGetRequest) {
      if (typeof query === 'string') {
        // preparse the query incase of GET so we can assert the operation.
        query = parse(query);
      }

      if (!isQueryOperation(query, requestParams.operationName)) {
        throw new HttpQueryError(405, `GET supports only query operation`, false, {
          'Allow': 'POST',
        });
      }
    }

    const operationName = requestParams.operationName;
    let variables = requestParams.variables;

    if (typeof variables === 'string') {
      try {
        variables = JSON.parse(variables);
      } catch (error) {
        throw new HttpQueryError(400, 'Variables are invalid JSON.');
      }
    }

    // Shallow clone context for queries in batches. This allows
    // users to distinguish multiple queries in the batch and to
    // modify the context object without interfering with each other.
    let context = optionsObject.context;
    if (isBatch) {
      context = Object.assign({}, context || {});
    }

    let params = {
      schema: optionsObject.schema,
      query: query,
      variables: variables,
      context: context,
      rootValue: optionsObject.rootValue,
      operationName: operationName,
      logFunction: optionsObject.logFunction,
      validationRules: optionsObject.validationRules,
      formatError: formatErrorFn,
      formatResponse: optionsObject.formatResponse,
      fieldResolver: optionsObject.fieldResolver,
      debug: optionsObject.debug,
      tracing: optionsObject.tracing,
    };

    if (optionsObject.formatParams) {
      params = optionsObject.formatParams(params);
    }

    return runQuery(params);
  } catch (e) {
    // Populate any HttpQueryError to our handler which should
    // convert it to Http Error.
    if (e.name === 'HttpQueryError') {
      return Promise.reject(e);
    }

    return Promise.resolve({ errors: [formatErrorFn(e)] });
  }
}

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { db, env } from '../lib.ts';
import {
  allowedResources,
  sessionState,
  validClaims,
  type StepUpSession,
  type TokenClaims,
} from '../session.ts';

/**
 * The web client lives in the web stack (its callback URL is the CloudFront
 * address, which exists only after the API). Its id is read from SSM once
 * per container instead of being passed in, which would make a cycle.
 */
let verifierPromise: Promise<ReturnType<typeof makeVerifier>> | undefined;

function makeVerifier(clientId: string) {
  return CognitoJwtVerifier.create({
    userPoolId: env('USER_POOL_ID'),
    clientId,
    tokenUse: 'access',
  });
}

function getVerifier() {
  verifierPromise ??= new SSMClient({})
    .send(new GetParameterCommand({ Name: env('WEB_CLIENT_ID_PARAM') }))
    .then((res) => {
      const id = res.Parameter?.Value;
      if (!id) throw new Error('Web client id parameter is empty');
      return makeVerifier(id);
    })
    .catch((err) => {
      verifierPromise = undefined; // retry on the next call
      throw err;
    });
  return verifierPromise;
}

function deny(): APIGatewayAuthorizerResult {
  // Unauthorized → API Gateway answers 401 without calling the handler.
  throw new Error('Unauthorized');
}

/**
 * Lambda authorizer (design 7.2): verifies the Cognito access token, then
 * applies the step-up rule for social sign-ins (design 6.2). Sessions that
 * still need step-up may only call the step-up routes and GET /me.
 */
export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const header = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return deny();

  let claims: TokenClaims;
  try {
    claims = (await (await getVerifier()).verify(token)) as unknown as TokenClaims;
  } catch {
    return deny();
  }
  if (!validClaims(claims)) return deny();

  let stepUp: StepUpSession | undefined;
  if (claims.mfa_level === 'federated') {
    const res = await db.send(
      new GetCommand({
        TableName: env('SESSIONS_TABLE'),
        Key: { PK: `SESSION#${claims.origin_jti}` },
      }),
    );
    stepUp = res.Item as StepUpSession | undefined;
  }
  const state = sessionState(claims, stepUp, Math.floor(Date.now() / 1000));

  return {
    principalId: claims.sub,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'execute-api:Invoke',
          Resource: allowedResources(event.methodArn, state.mfaSatisfied),
        },
      ],
    },
    context: {
      sub: claims.sub,
      role: claims.role!,
      ...(claims.artistId ? { artistId: claims.artistId } : {}),
      mfaLevel: claims.mfa_level === 'federated' ? 'federated' : 'cognito',
      mfaSatisfied: String(state.mfaSatisfied),
      authTime: String(state.authTime),
      sessionId: claims.origin_jti!,
    },
  };
};

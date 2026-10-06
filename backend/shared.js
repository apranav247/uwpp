import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true }
});

export const table = () => process.env.TABLE_NAME;

export const json = (statusCode, body) => ({
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
});

export const getAuth = (event) => {
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    if (!claims) return null;
    
    const orgId = claims['custom:orgId'];
    const userId = claims.sub;
    
    if (typeof orgId !== 'string' || typeof userId !== 'string' || !orgId || !userId) return null;
    if (!/^[a-z0-9-]{1,64}$/.test(orgId)) return null;
    
    return { orgId, userId };
};

export const orgPk = (orgId) => `ORG#${orgId}`;
export const userSk = (userId) => `USER#${userId}`;

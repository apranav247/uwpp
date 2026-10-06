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
export const projectSk = (id) => `PROJECT#${id}`;
export const taskSk = (id) => `TASK#${id}`;
export const taskGsi1Pk = (orgId, projectId) => `ORG#${orgId}#PROJECT#${projectId}`;
export const taskGsi1Sk = (id) => `TASK#${id}`;

export const parseBody = (event) => {
    if (!event.body) return null;
    try {
        let bodyStr = event.body;
        if (event.isBase64Encoded) {
            bodyStr = Buffer.from(bodyStr, 'base64').toString('utf8');
        }
        return JSON.parse(bodyStr);
    } catch (e) {
        return null;
    }
};

export const publicItem = (item) => {
    const { PK, SK, GSI1PK, GSI1SK, entityType, ...rest } = item;
    return rest;
};

export const isUuid = (value) => {
    if (typeof value !== 'string') return false;
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
};

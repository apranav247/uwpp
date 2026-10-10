import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

process.env.TABLE_NAME = 'TestTable';
const ddbMock = mockClient(DynamoDBDocumentClient);

import { handler } from '../backend/notifications/index.js';

describe('Notifications API', () => {
    beforeEach(() => {
        ddbMock.reset();
    });

    const createEvent = (claims) => ({
        requestContext: { authorizer: { jwt: { claims } } }
    });

    it('returns 403 if no claims', async () => {
        const result = await handler({});
        expect(result.statusCode).toBe(403);
    });

    it('queries table for user notifications', async () => {
        ddbMock.on(QueryCommand).resolves({
            Items: [
                { PK: 'ORG#org1', SK: 'NOTIF#user1#2024-01-01#id1', entityType: 'NOTIFICATION', message: 'Hello' }
            ]
        });

        const result = await handler(createEvent({ 'custom:orgId': 'org1', sub: 'user1' }));
        expect(result.statusCode).toBe(200);
        
        const body = JSON.parse(result.body);
        expect(body.items.length).toBe(1);
        expect(body.items[0].message).toBe('Hello');
        expect(body.items[0].PK).toBeUndefined();
        expect(body.items[0].SK).toBeUndefined();
        expect(body.items[0].entityType).toBeUndefined();

        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls.length).toBe(1);
        expect(calls[0].args[0].input).toMatchObject({
            TableName: 'TestTable',
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
            ExpressionAttributeValues: {
                ':pk': 'ORG#org1',
                ':skPrefix': 'NOTIF#user1#'
            },
            ScanIndexForward: false,
            Limit: 50
        });
    });

    it('returns 500 on dynamodb error', async () => {
        ddbMock.on(QueryCommand).rejects(new Error('DB Error'));
        const result = await handler(createEvent({ 'custom:orgId': 'org1', sub: 'user1' }));
        expect(result.statusCode).toBe(500);
        expect(JSON.parse(result.body).error).toBe('Internal error');
    });
});

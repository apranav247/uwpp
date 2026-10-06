import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../backend/projects/index.js';
import { isUuid } from '../backend/shared.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('Projects Lambda', () => {
    beforeEach(() => {
        ddbMock.reset();
        process.env.TABLE_NAME = 'test-table';
    });

    const mockAuth = {
        requestContext: {
            http: { method: 'GET' },
            authorizer: { jwt: { claims: { 'custom:orgId': 'orga', 'sub': 'u1' } } }
        }
    };

    it('GET uses organization from JWT claims', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        const response = await handler(mockAuth);
        expect(response.statusCode).toBe(200);
        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls[0].args[0].input.ExpressionAttributeValues[':pk']).toBe('ORG#orga');
    });

    it('GET ignores query-string orgId', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        const event = { ...mockAuth, queryStringParameters: { orgId: 'orgb' } };
        const response = await handler(event);
        expect(response.statusCode).toBe(200);
        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls[0].args[0].input.ExpressionAttributeValues[':pk']).toBe('ORG#orga');
    });

    it('POST stores orgId from JWT claim even when body contains a different orgId', async () => {
        ddbMock.on(PutCommand).resolves({});
        const event = {
            ...mockAuth,
            requestContext: { ...mockAuth.requestContext, http: { method: 'POST' } },
            body: JSON.stringify({ name: 'Project A', orgId: 'orgb' })
        };
        const response = await handler(event);
        expect(response.statusCode).toBe(201);
        const body = JSON.parse(response.body);
        expect(body.orgId).toBe('orga');
        expect(isUuid(body.projectId)).toBe(true);

        const putCalls = ddbMock.commandCalls(PutCommand);
        expect(putCalls[0].args[0].input.Item.orgId).toBe('orga');
    });

    it('Empty project name returns 400', async () => {
        const event = {
            ...mockAuth,
            requestContext: { ...mockAuth.requestContext, http: { method: 'POST' } },
            body: JSON.stringify({ name: '   ' })
        };
        const response = await handler(event);
        expect(response.statusCode).toBe(400);
    });

    it('101-character project name returns 400', async () => {
        const event = {
            ...mockAuth,
            requestContext: { ...mockAuth.requestContext, http: { method: 'POST' } },
            body: JSON.stringify({ name: 'A'.repeat(101) })
        };
        const response = await handler(event);
        expect(response.statusCode).toBe(400);
    });

    it('Invalid JSON returns 400', async () => {
        const event = {
            ...mockAuth,
            requestContext: { ...mockAuth.requestContext, http: { method: 'POST' } },
            body: '{bad_json'
        };
        const response = await handler(event);
        expect(response.statusCode).toBe(400);
    });

    it('Missing organization claim returns 403', async () => {
        const response = await handler({});
        expect(response.statusCode).toBe(403);
    });

    it('Missing organization claim makes zero DynamoDB calls', async () => {
        await handler({});
        expect(ddbMock.calls().length).toBe(0);
    });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../backend/users/index.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('GET /users', () => {
    beforeEach(() => {
        ddbMock.reset();
        process.env.TABLE_NAME = 'test-table';
    });

    it('returns users for caller orgId (ignores query params)', async () => {
        ddbMock.on(QueryCommand).resolves({
            Items: [
                { userId: 'u1', name: 'User 1', email: 'u1@example.com' }
            ]
        });

        const event = {
            requestContext: {
                authorizer: {
                    jwt: {
                        claims: { 'custom:orgId': 'orga', 'sub': 'u1' }
                    }
                }
            },
            queryStringParameters: { orgId: 'orgb' }
        };

        const response = await handler(event);
        
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ items: [{ userId: 'u1', name: 'User 1', email: 'u1@example.com' }] });
        
        const queryCalls = ddbMock.commandCalls(QueryCommand);
        expect(queryCalls.length).toBe(1);
        expect(queryCalls[0].args[0].input.ExpressionAttributeValues[':pk']).toBe('ORG#orga');
    });

    it('returns 403 if claims are missing', async () => {
        const response = await handler({});
        expect(response.statusCode).toBe(403);
        expect(JSON.parse(response.body).error).toBe('Missing organization claim');
        expect(ddbMock.commandCalls(QueryCommand).length).toBe(0);
    });

    it('returns 500 on db error without leaking details', async () => {
        ddbMock.on(QueryCommand).rejects(new Error('Secret DB error'));
        
        const event = {
            requestContext: {
                authorizer: {
                    jwt: {
                        claims: { 'custom:orgId': 'orga', 'sub': 'u1' }
                    }
                }
            }
        };

        const response = await handler(event);
        expect(response.statusCode).toBe(500);
        expect(JSON.parse(response.body).error).toBe('Internal error');
    });
});

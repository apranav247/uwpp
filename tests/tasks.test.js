import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { handler } from '../backend/tasks/index.js';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

describe('Tasks Lambda', () => {
    beforeEach(() => {
        ddbMock.reset();
        ebMock.reset();
        process.env.TABLE_NAME = 'test-table';
    });

    const mockAuth = {
        requestContext: {
            http: { method: 'GET' },
            authorizer: { jwt: { claims: { 'custom:orgId': 'orga', 'sub': 'u1' } } }
        }
    };

    it('GET without projectId -> 400', async () => {
        const response = await handler(mockAuth);
        expect(response.statusCode).toBe(400);
    });

    it('GET with non-UUID projectId -> 400', async () => {
        const event = { ...mockAuth, queryStringParameters: { projectId: '123' } };
        const response = await handler(event);
        expect(response.statusCode).toBe(400);
    });

    it('GET queries GSI1 with ORG#<claim-org>#PROJECT#<projectId>', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [] });
        const uuid = '12345678-1234-1234-1234-1234567890ab';
        const event = { ...mockAuth, queryStringParameters: { projectId: uuid } };
        const response = await handler(event);
        expect(response.statusCode).toBe(200);
        
        const calls = ddbMock.commandCalls(QueryCommand);
        expect(calls[0].args[0].input.IndexName).toBe('GSI1');
        expect(calls[0].args[0].input.ExpressionAttributeValues[':pk']).toBe(`ORG#orga#PROJECT#${uuid}`);
    });

    it('POST with a project that does not exist -> 404', async () => {
        ddbMock.on(GetCommand).resolves({ Item: undefined });
        const event = {
            ...mockAuth,
            requestContext: { http: { method: 'POST' }, authorizer: mockAuth.requestContext.authorizer },
            body: JSON.stringify({ projectId: '12345678-1234-1234-1234-1234567890ab', title: 'Task' })
        };
        const response = await handler(event);
        expect(response.statusCode).toBe(404);
    });

    it('POST ignores body assignedTo', async () => {
        ddbMock.on(GetCommand).resolves({ Item: { projectId: '12345678-1234-1234-1234-1234567890ab' } });
        ddbMock.on(PutCommand).resolves({});
        const event = {
            ...mockAuth,
            requestContext: { http: { method: 'POST' }, authorizer: mockAuth.requestContext.authorizer },
            body: JSON.stringify({ projectId: '12345678-1234-1234-1234-1234567890ab', title: 'Task', assignedTo: 'some-user' })
        };
        const response = await handler(event);
        expect(response.statusCode).toBe(201);
        const parsed = JSON.parse(response.body);
        expect(parsed.assignedTo).toBeUndefined();
    });

    it('PATCH status only -> 200 and NO event', async () => {
        const taskId = '12345678-1234-1234-1234-1234567890ab';
        ddbMock.on(GetCommand).resolves({ Item: { taskId } });
        ddbMock.on(UpdateCommand).resolves({ Attributes: { taskId, status: 'DONE' } });
        const event = {
            ...mockAuth,
            requestContext: { http: { method: 'PATCH' }, authorizer: mockAuth.requestContext.authorizer },
            pathParameters: { taskId },
            body: JSON.stringify({ status: 'DONE' })
        };
        const response = await handler(event);
        expect(response.statusCode).toBe(200);
        expect(ebMock.calls().length).toBe(0);
    });

    it('PATCH invalid status -> 400', async () => {
        const taskId = '12345678-1234-1234-1234-1234567890ab';
        const event = {
            ...mockAuth,
            requestContext: { http: { method: 'PATCH' }, authorizer: mockAuth.requestContext.authorizer },
            pathParameters: { taskId },
            body: JSON.stringify({ status: 'INVALID' })
        };
        const response = await handler(event);
        expect(response.statusCode).toBe(400);
    });

    it('PATCH assigning an existing same-org user -> 200 and exactly one PutEvents call occurs with correct detail', async () => {
        const taskId = '12345678-1234-1234-1234-1234567890ab';
        const userId = '87654321-4321-4321-4321-210987654321';
        
        // Mock GetItem for task and then GetItem for user
        ddbMock.on(GetCommand)
            .resolvesOnce({ Item: { taskId, projectId: 'p1' } }) // Task exists
            .resolvesOnce({ Item: { userId } }); // User exists in same org
            
        ddbMock.on(UpdateCommand).resolves({ Attributes: { taskId, assignedTo: userId, title: 'T' } });
        ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });

        const event = {
            ...mockAuth,
            requestContext: { http: { method: 'PATCH' }, authorizer: mockAuth.requestContext.authorizer },
            pathParameters: { taskId },
            body: JSON.stringify({ assignedTo: userId })
        };
        const response = await handler(event);
        expect(response.statusCode).toBe(200);
        
        const ebCalls = ebMock.commandCalls(PutEventsCommand);
        expect(ebCalls.length).toBe(1);
        const entry = ebCalls[0].args[0].input.Entries[0];
        expect(entry.Source).toBe('workforce.tasks');
        expect(entry.DetailType).toBe('TaskAssigned');
        
        const detail = JSON.parse(entry.Detail);
        expect(detail.organizationId).toBe('orga');
        expect(detail.assignedTo).toBe(userId);
    });

    it('PATCH assigning the same user already assigned -> NO event', async () => {
        const taskId = '12345678-1234-1234-1234-1234567890ab';
        const userId = '87654321-4321-4321-4321-210987654321';
        
        ddbMock.on(GetCommand)
            .resolvesOnce({ Item: { taskId, assignedTo: userId } }) // Task already assigned to same user
            .resolvesOnce({ Item: { userId } }); 
            
        ddbMock.on(UpdateCommand).resolves({ Attributes: { taskId, assignedTo: userId } });

        const event = {
            ...mockAuth,
            requestContext: { http: { method: 'PATCH' }, authorizer: mockAuth.requestContext.authorizer },
            pathParameters: { taskId },
            body: JSON.stringify({ assignedTo: userId })
        };
        const response = await handler(event);
        expect(response.statusCode).toBe(200);
        expect(ebMock.calls().length).toBe(0); // NO EVENT!
    });

    it('PATCH with assignee not found -> 400', async () => {
        const taskId = '12345678-1234-1234-1234-1234567890ab';
        const userId = '87654321-4321-4321-4321-210987654321';
        
        ddbMock.on(GetCommand)
            .resolvesOnce({ Item: { taskId } }) // Task exists
            .resolvesOnce({ Item: undefined }); // User NOT found
            
        const event = {
            ...mockAuth,
            requestContext: { http: { method: 'PATCH' }, authorizer: mockAuth.requestContext.authorizer },
            pathParameters: { taskId },
            body: JSON.stringify({ assignedTo: userId })
        };
        const response = await handler(event);
        expect(response.statusCode).toBe(400);
    });

    it('Failed PutEvents entry -> still 200 and logs error containing taskId', async () => {
        const taskId = '12345678-1234-1234-1234-1234567890ab';
        const userId = '87654321-4321-4321-4321-210987654321';
        
        ddbMock.on(GetCommand)
            .resolvesOnce({ Item: { taskId } }) 
            .resolvesOnce({ Item: { userId } }); 
            
        ddbMock.on(UpdateCommand).resolves({ Attributes: { taskId, assignedTo: userId } });
        ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 1 }); // FAILS

        let loggedError = '';
        const originalError = console.error;
        console.error = (msg) => { loggedError = msg; };

        const event = {
            ...mockAuth,
            requestContext: { http: { method: 'PATCH' }, authorizer: mockAuth.requestContext.authorizer },
            pathParameters: { taskId },
            body: JSON.stringify({ assignedTo: userId })
        };
        const response = await handler(event);
        console.error = originalError;

        expect(response.statusCode).toBe(200);
        expect(loggedError).toContain(taskId);
    });
});

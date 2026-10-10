import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

process.env.TABLE_NAME = 'TestTable';
const ddbMock = mockClient(DynamoDBDocumentClient);
const snsMock = mockClient(SNSClient);

import { handler } from '../backend/notifications/consumer.js';

describe('Notifications Consumer', () => {
    beforeEach(() => {
        ddbMock.reset();
        snsMock.reset();
        delete process.env.TOPIC_ARN;
    });

    const validEvent = {
        id: 'event123',
        'detail-type': 'TaskAssigned',
        detail: {
            taskId: 't1',
            projectId: 'p1',
            assignedTo: 'u2',
            assignedBy: 'u1',
            title: 'Task Title',
            timestamp: '2024-01-01T00:00:00Z',
            organizationId: 'org1'
        }
    };

    it('writes PutItem for valid event', async () => {
        await handler(validEvent);
        const calls = ddbMock.commandCalls(PutCommand);
        expect(calls.length).toBe(1);
        expect(calls[0].args[0].input.Item).toMatchObject({
            PK: 'ORG#org1',
            SK: 'NOTIF#u2#2024-01-01T00:00:00Z#event123',
            notificationId: 'event123',
            createdAt: '2024-01-01T00:00:00Z'
        });
        const snsCalls = snsMock.commandCalls(PublishCommand);
        expect(snsCalls.length).toBe(0);
    });

    it('publishes to SNS if TOPIC_ARN is set', async () => {
        process.env.TOPIC_ARN = 'arn:aws:sns:dummy';
        await handler(validEvent);
        
        const snsCalls = snsMock.commandCalls(PublishCommand);
        expect(snsCalls.length).toBe(1);
        expect(snsCalls[0].args[0].input.TopicArn).toBe('arn:aws:sns:dummy');
    });

    it('ignores invalid organizationId', async () => {
        await handler({ ...validEvent, detail: { ...validEvent.detail, organizationId: 'org!' } });
        expect(ddbMock.commandCalls(PutCommand).length).toBe(0);
    });

    it('rejects on dynamodb error to allow retry', async () => {
        const error = new Error('DB Error');
        error.$metadata = {}; // simulate AWS SDK error
        ddbMock.on(PutCommand).rejects(error);
        await expect(handler(validEvent)).rejects.toThrow('DB Error');
    });

    it('does not reject on sns error', async () => {
        process.env.TOPIC_ARN = 'arn:aws:sns:dummy';
        snsMock.on(PublishCommand).rejects(new Error('SNS Error'));
        await handler(validEvent); // Should not throw
        expect(ddbMock.commandCalls(PutCommand).length).toBe(1);
    });
});

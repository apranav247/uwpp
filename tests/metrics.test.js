import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

// Set process.env.TABLE_NAME before importing the handler
process.env.TABLE_NAME = 'TEST_TABLE';
const { handler } = await import('../backend/metrics/index.js');

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('Metrics API', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  const validEvent = {
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            'custom:orgId': 'org1',
            sub: 'user1'
          }
        }
      }
    }
  };

  it('returns 403 if missing orgId claim, with zero DynamoDB calls', async () => {
    const res = await handler({ requestContext: { authorizer: { jwt: { claims: { sub: 'user1' } } } } });
    expect(res.statusCode).toBe(403);
    expect(ddbMock.calls().length).toBe(0);
  });

  it('ignores query-string orgId and uses claim', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = {
      ...validEvent,
      queryStringParameters: { orgId: 'hacker_org' }
    };

    await handler(event);
    const calls = ddbMock.calls();
    expect(calls[0].args[0].input.ExpressionAttributeValues[':pk']).toBe('ORG#org1');
  });

  it('returns 500 on dynamodb error without leaking details', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('Secret DB error'));
    const res = await handler(validEvent);
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Internal error');
  });

  it('calculates correctly with zero tasks', async () => {
    // Users query
    ddbMock.on(QueryCommand, {
      ExpressionAttributeValues: { ':pk': 'ORG#org1', ':sk': 'USER#' }
    }).resolves({
      Items: [
        { userId: 'user1', name: 'Alice' }
      ]
    });

    // Tasks query
    ddbMock.on(QueryCommand, {
      ExpressionAttributeValues: { ':pk': 'ORG#org1', ':sk': 'TASK#' }
    }).resolves({ Items: [] });

    const res = await handler(validEvent);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.totalTasks).toBe(0);
    expect(body.completionRate).toBe(0);
    expect(body.unassigned).toBe(0);
    expect(body.tasksPerPerson.length).toBe(1);
    expect(body.tasksPerPerson[0]).toEqual({ userId: 'user1', name: 'Alice', total: 0, done: 0 });
  });

  it('calculates correctly: 1 of 3 (33.3) and 2 of 3 (66.7), unassigned, unknown assignees, zero-task users, and handles pagination', async () => {
    ddbMock.on(QueryCommand, {
      ExpressionAttributeValues: { ':pk': 'ORG#org1', ':sk': 'USER#' }
    }).resolves({
      Items: [
        { userId: 'user1', name: 'Alice' },
        { userId: 'user2', name: 'Bob' },
        { userId: 'user3', name: 'Charlie (Zero)' }
      ]
    });

    // We'll mock the tasks query to return 2 pages.
    // Page 1: 1 unassigned TODO, 1 assigned to user1 DONE.
    // Page 2: 1 assigned to user2 TODO. Total 3 tasks. 1 done. Rate: 33.3.
    ddbMock.on(QueryCommand, {
      ExpressionAttributeValues: { ':pk': 'ORG#org1', ':sk': 'TASK#' },
      ExclusiveStartKey: undefined
    }).resolves({
      Items: [
        { status: 'TODO' }, // unassigned
        { status: 'DONE', assignedTo: 'user1' }
      ],
      LastEvaluatedKey: { id: 'page1' }
    });

    ddbMock.on(QueryCommand, {
      ExpressionAttributeValues: { ':pk': 'ORG#org1', ':sk': 'TASK#' },
      ExclusiveStartKey: { id: 'page1' }
    }).resolves({
      Items: [
        { status: 'TODO', assignedTo: 'user2' }
      ]
    });

    const res1 = await handler(validEvent);
    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.totalTasks).toBe(3);
    expect(body1.doneTasks).toBe(1);
    expect(body1.completionRate).toBe(33.3);
    expect(body1.unassigned).toBe(1);

    // Test 2/3 done
    ddbMock.on(QueryCommand, {
      ExpressionAttributeValues: { ':pk': 'ORG#org1', ':sk': 'TASK#' },
      ExclusiveStartKey: undefined
    }).resolves({
      Items: [
        { status: 'TODO' }, // unassigned
        { status: 'DONE', assignedTo: 'user1' },
        { status: 'DONE', assignedTo: 'unknownUser' }
      ]
    }); // single page

    const res2 = await handler(validEvent);
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.totalTasks).toBe(3);
    expect(body2.doneTasks).toBe(2);
    expect(body2.completionRate).toBe(66.7);
    expect(body2.unassigned).toBe(1);
    expect(body2.tasksPerPerson).toEqual([
      { userId: 'user1', name: 'Alice', total: 1, done: 1 },
      { userId: 'user2', name: 'Bob', total: 0, done: 0 },
      { userId: 'user3', name: 'Charlie (Zero)', total: 0, done: 0 },
      { userId: 'unknown', name: 'Unknown user', total: 1, done: 1 }
    ]);
  });

  it('enforces a 50-page cap on tasks query', async () => {
    ddbMock.on(QueryCommand, {
      ExpressionAttributeValues: { ':pk': 'ORG#org1', ':sk': 'USER#' }
    }).resolves({ Items: [] });

    ddbMock.on(QueryCommand, {
      ExpressionAttributeValues: { ':pk': 'ORG#org1', ':sk': 'TASK#' }
    }).resolves({
      Items: [],
      LastEvaluatedKey: { id: 'fake' }
    });

    const res = await handler(validEvent);
    expect(res.statusCode).toBe(500); // Because it looped 50 times and aborted
  });

  it('uses consistent reads and right parameters for tasks query', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await handler(validEvent);
    const calls = ddbMock.calls();
    const taskCall = calls.find(c => c.args[0].input.ExpressionAttributeValues[':sk'] === 'TASK#');
    expect(taskCall.args[0].input.ConsistentRead).toBe(true);
    expect(taskCall.args[0].input.ProjectionExpression).toBe('#s, assignedTo');
    expect(taskCall.args[0].input.ExpressionAttributeNames['#s']).toBe('status');
  });
});

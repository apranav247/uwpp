import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handler as projectsHandler } from '../backend/projects/index.js';
import { handler as tasksHandler } from '../backend/tasks/index.js';
import * as shared from '../backend/shared.js';

// We intercept the ddb export from shared.js
vi.mock('../backend/shared.js', async (importOriginal) => {
    const actual = await importOriginal();
    
    // In-memory fake table
    let store = [];
    
    const fakeDdb = {
        send: async (cmd) => {
            const { input } = cmd;
            const cName = cmd.constructor.name;
            
            if (cName === 'GetCommand') {
                const item = store.find(i => i.PK === input.Key.PK && i.SK === input.Key.SK);
                return { Item: item };
            }
            if (cName === 'PutCommand') {
                store.push(input.Item);
                return {};
            }
            if (cName === 'UpdateCommand') {
                const idx = store.findIndex(i => i.PK === input.Key.PK && i.SK === input.Key.SK);
                if (idx === -1 && input.ConditionExpression === 'attribute_exists(PK)') {
                    const e = new Error('Condition failed');
                    e.name = 'ConditionalCheckFailedException';
                    throw e;
                }
                const item = { ...store[idx] };
                if (input.ExpressionAttributeValues[':status']) item.status = input.ExpressionAttributeValues[':status'];
                if (input.ExpressionAttributeValues[':assignedTo']) item.assignedTo = input.ExpressionAttributeValues[':assignedTo'];
                if (input.ExpressionAttributeValues[':updatedAt']) item.updatedAt = input.ExpressionAttributeValues[':updatedAt'];
                store[idx] = item;
                return { Attributes: item };
            }
            if (cName === 'QueryCommand') {
                if (input.IndexName === 'GSI1') {
                    const items = store.filter(i => i.GSI1PK === input.ExpressionAttributeValues[':pk']);
                    return { Items: items };
                } else {
                    const pkMatch = store.filter(i => i.PK === input.ExpressionAttributeValues[':pk']);
                    const skPrefix = input.ExpressionAttributeValues[':sk'];
                    const items = pkMatch.filter(i => i.SK.startsWith(skPrefix));
                    return { Items: items };
                }
            }
        },
        _reset: () => { store = []; },
        _seed: (item) => { store.push(item); },
        _getStore: () => store
    };

    return {
        ...actual,
        ddb: fakeDdb
    };
});

// Since ebClient is initialized inside tasks/index.js, we mock EventBridgeClient entirely
vi.mock('@aws-sdk/client-eventbridge', () => {
    return {
        EventBridgeClient: class { send() { return { FailedEntryCount: 0 }; } },
        PutEventsCommand: class { constructor(input) { this.input = input; } }
    };
});

describe('Tenant Isolation', () => {
    beforeEach(() => {
        shared.ddb._reset();
        
        // Seed OrgA
        shared.ddb._seed({ PK: 'ORG#orga', SK: 'PROJECT#11111111-1111-1111-1111-111111111111', entityType: 'PROJECT', projectId: '11111111-1111-1111-1111-111111111111' });
        shared.ddb._seed({ PK: 'ORG#orga', SK: 'TASK#11111111-1111-1111-1111-222222222222', GSI1PK: 'ORG#orga#PROJECT#11111111-1111-1111-1111-111111111111', entityType: 'TASK', taskId: '11111111-1111-1111-1111-222222222222' });
        shared.ddb._seed({ PK: 'ORG#orga', SK: 'USER#11111111-1111-1111-1111-333333333333', entityType: 'USER', userId: '11111111-1111-1111-1111-333333333333' });

        // Seed OrgB
        shared.ddb._seed({ PK: 'ORG#orgb', SK: 'PROJECT#bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', entityType: 'PROJECT', projectId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
        shared.ddb._seed({ PK: 'ORG#orgb', SK: 'TASK#bbbbbbbb-bbbb-bbbb-bbbb-cccccccccccc', GSI1PK: 'ORG#orgb#PROJECT#bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', entityType: 'TASK', taskId: 'bbbbbbbb-bbbb-bbbb-bbbb-cccccccccccc' });
        shared.ddb._seed({ PK: 'ORG#orgb', SK: 'USER#bbbbbbbb-bbbb-bbbb-bbbb-dddddddddddd', entityType: 'USER', userId: 'bbbbbbbb-bbbb-bbbb-bbbb-dddddddddddd' });
    });

    const getEvent = (method, path, orgId, userId, extra = {}) => ({
        requestContext: { http: { method, path }, authorizer: { jwt: { claims: { 'custom:orgId': orgId, sub: userId } } } },
        ...extra
    });

    it('OrgB user proves isolation against OrgA data', async () => {
        // a. GET /projects returns only OrgB projects
        const r1 = await projectsHandler(getEvent('GET', '/projects', 'orgb', 'user-b'));
        expect(JSON.parse(r1.body).items.length).toBe(1);
        expect(JSON.parse(r1.body).items[0].projectId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

        // b. GET /tasks?projectId=<OrgA project id> returns empty
        const r2 = await tasksHandler(getEvent('GET', '/tasks', 'orgb', 'user-b', { queryStringParameters: { projectId: '11111111-1111-1111-1111-111111111111' } }));
        expect(JSON.parse(r2.body).items.length).toBe(0);

        // c. PATCH /tasks/<OrgA task id> returns 404
        const r3 = await tasksHandler(getEvent('PATCH', '/tasks', 'orgb', 'user-b', { pathParameters: { taskId: '11111111-1111-1111-1111-222222222222' }, body: JSON.stringify({ status: 'DONE' }) }));
        expect(r3.statusCode).toBe(404);

        // d. POST /tasks with an OrgA projectId returns 404
        const r4 = await tasksHandler(getEvent('POST', '/tasks', 'orgb', 'user-b', { body: JSON.stringify({ projectId: '11111111-1111-1111-1111-111111111111', title: 'T' }) }));
        expect(r4.statusCode).toBe(404);

        // e. Assigning an OrgA user to an OrgB task returns 400
        const r5 = await tasksHandler(getEvent('PATCH', '/tasks', 'orgb', 'user-b', { pathParameters: { taskId: 'bbbbbbbb-bbbb-bbbb-bbbb-cccccccccccc' }, body: JSON.stringify({ assignedTo: '11111111-1111-1111-1111-333333333333' }) }));
        expect(r5.statusCode).toBe(400);

        // f. OrgA data remains unchanged
        const orgaTask = shared.ddb._getStore().find(i => i.taskId === '11111111-1111-1111-1111-222222222222');
        expect(orgaTask.status).toBeUndefined(); // Didn't get changed to DONE
    });

    it('OrgA user proves isolation against OrgB data', async () => {
        // a. GET /projects returns only OrgA projects
        const r1 = await projectsHandler(getEvent('GET', '/projects', 'orga', 'user-a'));
        expect(JSON.parse(r1.body).items.length).toBe(1);
        expect(JSON.parse(r1.body).items[0].projectId).toBe('11111111-1111-1111-1111-111111111111');

        // b. GET /tasks?projectId=<OrgB project id> returns empty
        const r2 = await tasksHandler(getEvent('GET', '/tasks', 'orga', 'user-a', { queryStringParameters: { projectId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' } }));
        expect(JSON.parse(r2.body).items.length).toBe(0);

        // c. PATCH /tasks/<OrgB task id> returns 404
        const r3 = await tasksHandler(getEvent('PATCH', '/tasks', 'orga', 'user-a', { pathParameters: { taskId: 'bbbbbbbb-bbbb-bbbb-bbbb-cccccccccccc' }, body: JSON.stringify({ status: 'DONE' }) }));
        expect(r3.statusCode).toBe(404);

        // d. POST /tasks with an OrgB projectId returns 404
        const r4 = await tasksHandler(getEvent('POST', '/tasks', 'orga', 'user-a', { body: JSON.stringify({ projectId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', title: 'T' }) }));
        expect(r4.statusCode).toBe(404);

        // e. Assigning an OrgB user to an OrgA task returns 400
        const r5 = await tasksHandler(getEvent('PATCH', '/tasks', 'orga', 'user-a', { pathParameters: { taskId: '11111111-1111-1111-1111-222222222222' }, body: JSON.stringify({ assignedTo: 'bbbbbbbb-bbbb-bbbb-bbbb-dddddddddddd' }) }));
        expect(r5.statusCode).toBe(400);

        // f. OrgB data remains unchanged
        const orgbTask = shared.ddb._getStore().find(i => i.taskId === 'bbbbbbbb-bbbb-bbbb-bbbb-cccccccccccc');
        expect(orgbTask.status).toBeUndefined(); // Didn't get changed to DONE
    });
});

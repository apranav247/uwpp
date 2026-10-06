import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'crypto';
import { ddb, table, json, getAuth, orgPk, taskSk, projectSk, taskGsi1Pk, taskGsi1Sk, parseBody, publicItem, isUuid, userSk } from '../shared.js';

const ebClient = new EventBridgeClient({});

export const handler = async (event) => {
    try {
        const auth = getAuth(event);
        if (!auth) return json(403, { error: "Missing organization claim" });

        const method = event.requestContext?.http?.method;

        if (method === 'GET') {
            const projectId = event.queryStringParameters?.projectId;
            if (!projectId || !isUuid(projectId)) {
                return json(400, { error: "projectId query parameter required and must be a UUID" });
            }

            const result = await ddb.send(new QueryCommand({
                TableName: table(),
                IndexName: 'GSI1',
                KeyConditionExpression: "GSI1PK = :pk",
                ExpressionAttributeValues: {
                    ":pk": taskGsi1Pk(auth.orgId, projectId)
                },
                Limit: 100
            }));
            const items = (result.Items || []).map(publicItem);
            return json(200, { items });
        }

        if (method === 'POST') {
            const body = parseBody(event);
            if (!body) return json(400, { error: "Invalid JSON body" });

            if (!body.projectId || !isUuid(body.projectId)) return json(400, { error: "projectId required and must be UUID" });
            if (typeof body.title !== 'string') return json(400, { error: "Title must be a string" });
            const title = body.title.trim();
            if (title.length < 1 || title.length > 200) return json(400, { error: "Title length must be 1-200" });

            let description = null;
            if (body.description !== undefined) {
                if (typeof body.description !== 'string') return json(400, { error: "Description must be a string" });
                if (body.description.length > 2000) return json(400, { error: "Description maximum 2000 characters" });
                description = body.description;
            }

            const projectRes = await ddb.send(new GetCommand({
                TableName: table(),
                Key: {
                    PK: orgPk(auth.orgId),
                    SK: projectSk(body.projectId)
                }
            }));
            if (!projectRes.Item) return json(404, { error: "Project not found" });

            const taskId = randomUUID();
            const now = new Date().toISOString();

            const item = {
                PK: orgPk(auth.orgId),
                SK: taskSk(taskId),
                GSI1PK: taskGsi1Pk(auth.orgId, body.projectId),
                GSI1SK: taskGsi1Sk(taskId),
                entityType: "TASK",
                taskId,
                orgId: auth.orgId,
                projectId: body.projectId,
                title,
                status: "TODO",
                createdBy: auth.userId,
                createdAt: now,
                updatedAt: now
            };
            if (description !== null) {
                item.description = description;
            }

            await ddb.send(new PutCommand({
                TableName: table(),
                Item: item
            }));

            return json(201, publicItem(item));
        }

        if (method === 'PATCH') {
            const taskId = event.pathParameters?.taskId;
            if (!taskId || !isUuid(taskId)) return json(400, { error: "Invalid taskId" });

            const body = parseBody(event);
            if (!body) return json(400, { error: "Invalid JSON body" });

            if (body.status === undefined && body.assignedTo === undefined) {
                return json(400, { error: "Provide status or assignedTo" });
            }

            if (body.status !== undefined && !['TODO', 'IN_PROGRESS', 'DONE'].includes(body.status)) {
                return json(400, { error: "Invalid status" });
            }
            if (body.assignedTo !== undefined && !isUuid(body.assignedTo)) {
                return json(400, { error: "assignedTo must be a UUID" });
            }

            // Step 1: Get the task
            const taskRes = await ddb.send(new GetCommand({
                TableName: table(),
                Key: {
                    PK: orgPk(auth.orgId),
                    SK: taskSk(taskId)
                }
            }));
            const existingTask = taskRes.Item;
            if (!existingTask) return json(404, { error: "Task not found" });

            // Step 2: Validate assignee
            if (body.assignedTo !== undefined) {
                const userRes = await ddb.send(new GetCommand({
                    TableName: table(),
                    Key: {
                        PK: orgPk(auth.orgId),
                        SK: userSk(body.assignedTo)
                    }
                }));
                if (!userRes.Item) {
                    return json(400, { error: "Assignee does not belong to your organization" });
                }
            }

            // Step 3: UpdateItem
            const now = new Date().toISOString();
            let updateExpr = "SET updatedAt = :updatedAt";
            const exprNames = {};
            const exprValues = { ":updatedAt": now };

            if (body.status !== undefined) {
                updateExpr += ", #status = :status";
                exprNames["#status"] = "status";
                exprValues[":status"] = body.status;
            }
            if (body.assignedTo !== undefined) {
                updateExpr += ", assignedTo = :assignedTo";
                exprValues[":assignedTo"] = body.assignedTo;
            }

            const updateParams = {
                TableName: table(),
                Key: {
                    PK: orgPk(auth.orgId),
                    SK: taskSk(taskId)
                },
                ConditionExpression: "attribute_exists(PK)",
                UpdateExpression: updateExpr,
                ExpressionAttributeValues: exprValues,
                ReturnValues: "ALL_NEW"
            };
            
            if (Object.keys(exprNames).length > 0) {
                updateParams.ExpressionAttributeNames = exprNames;
            }

            let updateRes;
            try {
                updateRes = await ddb.send(new UpdateCommand(updateParams));
            } catch (err) {
                if (err.name === 'ConditionalCheckFailedException') {
                    return json(404, { error: "Task not found" });
                }
                throw err;
            }
            const updatedTask = updateRes.Attributes;

            // Step 4: Emit event
            if (body.assignedTo !== undefined && body.assignedTo !== existingTask.assignedTo) {
                const putEventsRes = await ebClient.send(new PutEventsCommand({
                    Entries: [
                        {
                            Source: "workforce.tasks",
                            DetailType: "TaskAssigned",
                            Detail: JSON.stringify({
                                taskId: updatedTask.taskId,
                                projectId: updatedTask.projectId,
                                organizationId: auth.orgId,
                                assignedTo: updatedTask.assignedTo,
                                assignedBy: auth.userId,
                                title: updatedTask.title,
                                timestamp: updatedTask.updatedAt
                            })
                        }
                    ]
                }));
                if (putEventsRes.FailedEntryCount > 0) {
                    console.error(`PutEvents failed for task ${updatedTask.taskId}`);
                }
            }

            // Step 5
            return json(200, publicItem(updatedTask));
        }

        return json(405, { error: "Method Not Allowed" });

    } catch (error) {
        console.error(error.message);
        return json(500, { error: "Internal error" });
    }
};

import { QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { ddb, table, json, getAuth, orgPk, projectSk, parseBody, publicItem } from '../shared.js';

export const handler = async (event) => {
    try {
        const auth = getAuth(event);
        if (!auth) return json(403, { error: "Missing organization claim" });

        const method = event.requestContext?.http?.method;

        if (method === 'GET') {
            const result = await ddb.send(new QueryCommand({
                TableName: table(),
                KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
                ExpressionAttributeValues: {
                    ":pk": orgPk(auth.orgId),
                    ":sk": "PROJECT#"
                },
                Limit: 100
            }));
            const items = (result.Items || []).map(publicItem);
            return json(200, { items });
        }

        if (method === 'POST') {
            const body = parseBody(event);
            if (!body) return json(400, { error: "Invalid JSON body" });

            if (typeof body.name !== 'string') return json(400, { error: "Name must be a string" });
            const name = body.name.trim();
            if (name.length < 1 || name.length > 100) return json(400, { error: "Name length must be 1-100" });

            let description = null;
            if (body.description !== undefined) {
                if (typeof body.description !== 'string') return json(400, { error: "Description must be a string" });
                description = body.description;
                if (description.length > 500) return json(400, { error: "Description maximum 500 characters" });
            }

            const projectId = randomUUID();
            const now = new Date().toISOString();

            const item = {
                PK: orgPk(auth.orgId),
                SK: projectSk(projectId),
                entityType: "PROJECT",
                projectId,
                orgId: auth.orgId,
                name,
                createdBy: auth.userId,
                createdAt: now
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

        return json(405, { error: "Method Not Allowed" });

    } catch (error) {
        console.error(error.message);
        return json(500, { error: "Internal error" });
    }
};

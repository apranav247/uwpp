import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, table, json, getAuth, orgPk } from '../shared.js';

export const handler = async (event) => {
    try {
        const auth = getAuth(event);
        if (!auth) return json(403, { error: "Missing organization claim" });

        const result = await ddb.send(new QueryCommand({
            TableName: table(),
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
            ExpressionAttributeValues: {
                ":pk": orgPk(auth.orgId),
                ":sk": "USER#"
            },
            Limit: 100
        }));

        const items = (result.Items || []).map(item => ({
            userId: item.userId,
            name: item.name,
            email: item.email
        }));

        return json(200, { items });
    } catch (error) {
        console.error(error.message);
        return json(500, { error: "Internal error" });
    }
};

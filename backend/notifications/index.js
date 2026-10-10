import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, table, getAuth, json, orgPk, notifPrefix, publicItem } from '../shared.js';

export const handler = async (event) => {
    try {
        const auth = getAuth(event);
        if (!auth) {
            return json(403, { error: 'Missing organization claim' });
        }

        const data = await ddb.send(new QueryCommand({
            TableName: table(),
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
            ExpressionAttributeValues: {
                ':pk': orgPk(auth.orgId),
                ':skPrefix': notifPrefix(auth.userId)
            },
            ScanIndexForward: false,
            Limit: 50
        }));

        const items = (data.Items || []).map(publicItem);
        return json(200, { items });
    } catch (error) {
        console.error(error.message);
        return json(500, { error: 'Internal error' });
    }
};

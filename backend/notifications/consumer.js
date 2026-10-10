import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { ddb, table, orgPk, notifSk } from '../shared.js';

let snsClient = null;

export const handler = async (event) => {
    try {
        if (typeof event.id !== 'string' || !event.id) {
            console.error('Invalid event: missing id');
            return;
        }

        const detail = event.detail;
        if (!detail || 
            typeof detail.taskId !== 'string' ||
            typeof detail.projectId !== 'string' ||
            typeof detail.assignedTo !== 'string' ||
            typeof detail.assignedBy !== 'string' ||
            typeof detail.title !== 'string' ||
            typeof detail.timestamp !== 'string' ||
            typeof detail.organizationId !== 'string' ||
            !/^[a-z0-9-]{1,64}$/.test(detail.organizationId)) {
            console.error(`Invalid event format for id: ${event.id}`);
            return;
        }

        const titleTruncated = detail.title.length > 200 ? detail.title.substring(0, 197) + '...' : detail.title;
        const message = "You were assigned: " + titleTruncated;

        const item = {
            PK: orgPk(detail.organizationId),
            SK: notifSk(detail.assignedTo, detail.timestamp, event.id),
            entityType: 'NOTIFICATION',
            notificationId: event.id,
            orgId: detail.organizationId,
            userId: detail.assignedTo,
            type: 'TASK_ASSIGNED',
            taskId: detail.taskId,
            projectId: detail.projectId,
            title: detail.title,
            message: message,
            assignedBy: detail.assignedBy,
            createdAt: detail.timestamp
        };

        try {
            await ddb.send(new PutCommand({
                TableName: table(),
                Item: item
            }));
        } catch (dbError) {
            console.error(`DynamoDB error: ${dbError.message}`);
            throw dbError;
        }

        const topicArn = process.env.TOPIC_ARN;
        if (topicArn) {
            if (!snsClient) snsClient = new SNSClient({});
            try {
                const subject = "Task assigned".substring(0, 100);
                const snsMessage = `${message}\nTask: ${detail.title}`;
                await snsClient.send(new PublishCommand({
                    TopicArn: topicArn,
                    Subject: subject,
                    Message: snsMessage
                }));
            } catch (snsError) {
                console.error(snsError.name);
            }
        }
    } catch (e) {
        if (e.name !== 'ConditionalCheckFailedException' && e.$metadata) {
             throw e;
        } else if (!e.$metadata) {
            console.error('Unhandled error');
        } else {
             throw e;
        }
    }
};

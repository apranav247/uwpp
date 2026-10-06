import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminUpdateUserAttributesCommand, AdminSetUserPasswordCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const STACK_NAME = process.env.STACK_NAME || "uwpp-app";
const AWS_REGION = process.env.AWS_REGION || "ap-southeast-2";
const SEED_PASSWORD = process.env.SEED_PASSWORD;

if (!SEED_PASSWORD || SEED_PASSWORD.length < 8) {
    console.error("SEED_PASSWORD env var is missing or too short.");
    process.exit(1);
}

const cfn = new CloudFormationClient({ region: AWS_REGION });
const cognito = new CognitoIdentityProviderClient({ region: AWS_REGION });
const ddbClient = new DynamoDBClient({ region: AWS_REGION });
const ddb = DynamoDBDocumentClient.from(ddbClient, { marshallOptions: { removeUndefinedValues: true } });

const orgs = [
    { id: "orga", name: "OrgA" },
    { id: "orgb", name: "OrgB" }
];

const usersData = [
    { email: "usera@example.com", name: "User A", orgId: "orga" },
    { email: "userb@example.com", name: "User B", orgId: "orga" },
    { email: "userc@example.com", name: "User C", orgId: "orgb" }
];

const validateOrgId = (id) => {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) {
        throw new Error(`Invalid orgId: ${id}`);
    }
};

const run = async () => {
    console.log(`Fetching outputs for stack: ${STACK_NAME}`);
    const stackRes = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
    const outputs = stackRes.Stacks[0].Outputs;
    const userPoolId = outputs.find(o => o.OutputKey === 'UserPoolId').OutputValue;
    const tableName = outputs.find(o => o.OutputKey === 'TableName').OutputValue;

    for (const org of orgs) {
        validateOrgId(org.id);
        const createdAt = new Date().toISOString();
        await ddb.send(new PutCommand({
            TableName: tableName,
            Item: {
                PK: `ORG#${org.id}`,
                SK: `META`,
                entityType: "ORG",
                orgId: org.id,
                name: org.name,
                createdAt
            }
        }));
    }

    const summary = [];

    for (const user of usersData) {
        validateOrgId(user.orgId);
        try {
            await cognito.send(new AdminCreateUserCommand({
                UserPoolId: userPoolId,
                Username: user.email,
                MessageAction: "SUPPRESS",
                UserAttributes: [
                    { Name: "email", Value: user.email },
                    { Name: "email_verified", Value: "true" },
                    { Name: "name", Value: user.name },
                    { Name: "custom:orgId", Value: user.orgId }
                ]
            }));
        } catch (e) {
            if (e.name !== 'UsernameExistsException') throw e;
        }

        await cognito.send(new AdminUpdateUserAttributesCommand({
            UserPoolId: userPoolId,
            Username: user.email,
            UserAttributes: [
                { Name: "custom:orgId", Value: user.orgId },
                { Name: "name", Value: user.name }
            ]
        }));

        await cognito.send(new AdminSetUserPasswordCommand({
            UserPoolId: userPoolId,
            Username: user.email,
            Password: SEED_PASSWORD,
            Permanent: true
        }));

        const userRes = await cognito.send(new AdminGetUserCommand({
            UserPoolId: userPoolId,
            Username: user.email
        }));
        
        const sub = userRes.UserAttributes.find(a => a.Name === 'sub').Value;

        const createdAt = new Date().toISOString();
        await ddb.send(new PutCommand({
            TableName: tableName,
            Item: {
                PK: `ORG#${user.orgId}`,
                SK: `USER#${sub}`,
                entityType: "USER",
                userId: sub,
                orgId: user.orgId,
                email: user.email,
                name: user.name,
                createdAt
            }
        }));

        summary.push({ email: user.email, orgId: user.orgId, userId: sub });
    }

    console.table(summary);
};

run().catch(e => {
    console.error(e);
    process.exit(1);
});
